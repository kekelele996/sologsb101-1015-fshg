/**
 * 传输层（纯逻辑）：接收分片 + 断点续传 + 幂等。
 *
 * - 收到已确认过的分片：原样返回旧 ack，不重复对账（重试安全）；
 * - 传一半失败：只推进未确认分片，已认下分片不回滚；
 * - 网络恢复：凭会话 lastSeq 从下一片接着传，全部到齐会话置 complete。
 *
 * 「按那头重试」：本模块是档案室接收端，会话与断点都记在接收端；
 * 平板只要把同一个不可变包重投即可，接收端告诉它下一片该是几。
 */
import type { ChunkAck, PackageChunk, SendOutcome, SessionPort, TransferSession } from '../../types/transfer'
import { SESSION_STATUS } from '../../types/transfer'
import { reconcilePatrolBatch } from './reconcile'
import { nowIso } from '../id'

/** 接收一片：幂等。返回该片确认信息。 */
export async function receiveChunk(port: SessionPort, chunk: PackageChunk, at = nowIso()): Promise<ChunkAck> {
  const session = await ensureSession(port, chunk.packageId, chunk.origin, chunk.total, at)

  const prior = session.acks[chunk.seq]
  if (prior !== undefined) {
    // 同一片重投（网络抖动 / 重连）：不重复对账，原样回执
    return prior
  }

  // 防止乱序覆盖断点：只接受「恰好下一片」；调用方应先据 lastSeq 选片
  const expectedSeq = session.lastSeq + 1
  if (chunk.seq !== expectedSeq) {
    throw new Error(`分片乱序：期望 seq=${expectedSeq}，收到 seq=${chunk.seq}，请从断点续传`)
  }

  const results = await reconcilePatrolBatch(port, chunk.origin, chunk.items, at)
  const ack: ChunkAck = { seq: chunk.seq, count: chunk.items.length, results }
  const next: TransferSession = {
    ...session,
    lastSeq: chunk.seq,
    acks: { ...session.acks, [chunk.seq]: ack },
    status: chunk.seq + 1 >= chunk.total ? SESSION_STATUS.complete : SESSION_STATUS.transferring,
    completedAt: chunk.seq + 1 >= chunk.total ? at : null,
  }
  await port.putSession(next)
  return ack
}

async function ensureSession(
  port: SessionPort,
  packageId: string,
  origin: string,
  total: number,
  at: string,
): Promise<TransferSession> {
  const found = await port.getSession(packageId)
  if (found !== null) return found
  const created: TransferSession = {
    packageId,
    origin,
    total,
    lastSeq: -1,
    acks: {},
    status: SESSION_STATUS.transferring,
    startedAt: at,
    completedAt: null,
  }
  await port.putSession(created)
  return created
}

/**
 * 发送端驱动：把一个包的若干片依次投给接收端。
 * @param send 实际投递动作（可在此模拟断网 throw）；断网时已认下片不受影响
 * @returns 本次投到的断点；complete=false 时调用方可在网络恢复后用 resumePackage 接着传
 */
export async function sendPackage(
  port: SessionPort,
  chunks: PackageChunk[],
  send: (chunk: PackageChunk) => Promise<ChunkAck>,
): Promise<SendOutcome> {
  if (chunks.length === 0) throw new Error('没有可发送的分片')
  const packageId = chunks[0].packageId
  let lastAck: ChunkAck | null = null
  for (const chunk of chunks) {
    // 发送前先问断点：接收端若已认过这片则跳过（send 内部也幂等，双保险）
    lastAck = await send(chunk)
  }
  const session = await port.getSession(packageId)
  const allAcks = session ? Object.values(session.acks) : lastAck ? [lastAck] : []
  return {
    packageId,
    ackedSeq: session?.lastSeq ?? lastAck?.seq ?? -1,
    complete: session?.status === SESSION_STATUS.complete,
    results: allAcks.flatMap((ack) => ack.results),
  }
}

/**
 * 断点续传：从接收端会话读出已确认片，只把未确认片重投。
 * 已认下那头（片）不受影响；网络恢复后调用即可补齐。
 */
export async function resumePackage(
  port: SessionPort,
  chunksBySeq: PackageChunk[],
  send: (chunk: PackageChunk) => Promise<ChunkAck>,
): Promise<SendOutcome> {
  const packageId = chunksBySeq[0]?.packageId
  if (packageId === undefined) throw new Error('续传缺少分片')
  const session = await port.getSession(packageId)
  const ackedSeqs = new Set(session ? Object.keys(session.acks).map(Number) : [])
  const pending = chunksBySeq.filter((chunk) => !ackedSeqs.has(chunk.seq))
  // 全部片都已认下（例如上次其实已传完、只是回执丢了）：直接返回完成态，不再投
  if (pending.length === 0) {
    const acks = session ? Object.values(session.acks) : []
    return {
      packageId,
      ackedSeq: session?.lastSeq ?? -1,
      complete: session?.status === SESSION_STATUS.complete,
      results: acks.flatMap((ack) => ack.results),
    }
  }
  return sendPackage(port, pending, send)
}
