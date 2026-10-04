/**
 * 传输域类型：平板回办公室交「巡查包」，按分片续传。
 * - 包不可变：同一 packageId 的内容（分片序与条目）固定；
 * - 接收端按 (packageId, seq) 幂等，传一半失败后只重试未确认的分片；
 * - 已认下的分片不回滚，网络恢复后从断点接着传。
 */
import type { OriginId, PatrolPayload, ReconcilePort, ReconcileResult } from './sync'

/** 巡查包里的一条（一树一条巡查单） */
export interface PatrolItem {
  treeId: string
  version: number
  payload: PatrolPayload
}

/** 巡查包：由某台平板在某次下山时封包 */
export interface PatrolPackage {
  packageId: string
  origin: OriginId
  sealedAt: string
  /** 树号排序后的不可变条目 */
  items: PatrolItem[]
}

/** 分片：一个包被切成若干片，seq 从 0 起连续 */
export interface PackageChunk {
  packageId: string
  origin: OriginId
  total: number
  seq: number
  items: PatrolItem[]
}

/** 分片确认：接收端记录已认到的断点 */
export interface ChunkAck {
  seq: number
  count: number
  /** 本片各条的对账结论 */
  results: ReconcileResult[]
}

/** 传输会话状态 */
export const SESSION_STATUS = {
  transferring: 'transferring',
  complete: 'complete',
} as const

export type SessionStatus = (typeof SESSION_STATUS)[keyof typeof SESSION_STATUS]

/** 档案室侧的传输会话：记录断点，支撑续传与幂等 */
export interface TransferSession {
  packageId: string
  origin: OriginId
  total: number
  /** 已确认的最大分片序；-1 表示一片都还没到 */
  lastSeq: number
  /** 每个已确认分片的确认信息（seq -> ack） */
  acks: Record<number, ChunkAck>
  status: SessionStatus
  startedAt: string
  completedAt: string | null
}

/** 接收分片所需端口：传输层不直接碰 IndexedDB，由存储实现；复用对账端口 */
export interface SessionPort extends ReconcilePort {
  getSession(packageId: string): Promise<TransferSession | null>
  putSession(session: TransferSession): Promise<void>
  reconcile?(
    origin: OriginId,
    items: PatrolItem[],
  ): Promise<ReconcileResult[]>
}

/** 发送分片的返回：带上当前断点 */
export interface SendOutcome {
  packageId: string
  ackedSeq: number
  complete: boolean
  results: ReconcileResult[]
}
