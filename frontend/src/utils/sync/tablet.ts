/**
 * 平板侧（巡查半）：离线起草巡查单、按设备自管版本、回办公室封巡查包。
 * 平板本地只有巡查数据与「已交包」记录，物理上不持有正式档案半 / 复核标记。
 */
import type { OriginId, PatrolPayload } from '../../types/sync'
import type { ChunkAck, PackageChunk, PatrolItem, PatrolPackage } from '../../types/transfer'
import { nowIso, uuid } from '../id'

/** 平板上的一条巡查草稿 */
export interface PatrolDraft {
  treeId: string
  /** 本设备对该树的单调版本 */
  version: number
  payload: PatrolPayload
  /** 已随某个包交走的版本（>0 表示已交）；之后再改会产生下一版 */
  sealedVersion: number
  updatedAt: string
}

/** 平板本地状态 */
export interface TabletState {
  origin: OriginId
  drafts: Record<string, PatrolDraft>
  /** 已封包记录 */
  sealedPackages: string[]
}

export function createTabletState(origin: OriginId): TabletState {
  return { origin, drafts: {}, sealedPackages: [] }
}

/** 记录或更新巡查单（同一设备同一棵树版本 +1） */
export function saveDraft(state: TabletState, treeId: string, payload: PatrolPayload, at = nowIso()): PatrolDraft {
  const prev = state.drafts[treeId]
  const version = prev ? prev.version + 1 : 1
  const draft: PatrolDraft = { treeId, version, payload, sealedVersion: prev?.sealedVersion ?? 0, updatedAt: at }
  state.drafts[treeId] = draft
  return draft
}

/** 取出「本设备上自上次封包后有更新」的草稿 */
export function pendingDrafts(state: TabletState): PatrolDraft[] {
  return Object.values(state.drafts)
    .filter((draft) => draft.version > draft.sealedVersion)
    .sort((a, b) => a.treeId.localeCompare(b.treeId))
}

function draftToItem(draft: PatrolDraft): PatrolItem {
  return { treeId: draft.treeId, version: draft.version, payload: draft.payload }
}

/**
 * 封巡查包：只收未交的更新（version > sealedVersion），固定 packageId 与条目，不可变。
 * 没有待交项时返回 null（空包不传）。
 */
export function sealPackage(state: TabletState, at = nowIso(), packageId = uuid('pkg')): PatrolPackage | null {
  const drafts = pendingDrafts(state)
  if (drafts.length === 0) return null
  const items = drafts.map(draftToItem)
  drafts.forEach((draft) => {
    draft.sealedVersion = draft.version
  })
  state.sealedPackages.push(packageId)
  return { packageId, origin: state.origin, sealedAt: at, items }
}

/**
 * 按 (packageId, seq) 切巡查包，seq 从 0 起连续。
 * 失败重试只重发未确认的片，调用方对照返回的 ack 列表决定下一片。
 */
export function selectUnackedChunks(pkg: PatrolPackage, acks: ChunkAck[], chunkSize: number): PackageChunk[] {
  const ackedSeqs = new Set(acks.map((ack) => ack.seq))
  return chunkPackage(pkg, chunkSize).filter((chunk) => !ackedSeqs.has(chunk.seq))
}

/** 把不可变的包按片大小切片（seq 从 0 起连续） */
export function chunkPackage(pkg: PatrolPackage, chunkSize: number): PackageChunk[] {
  if (chunkSize <= 0) throw new Error('分片大小必须为正整数')
  const total = Math.ceil(pkg.items.length / chunkSize)
  const chunks: PackageChunk[] = []
  for (let seq = 0; seq < total; seq += 1) {
    chunks.push({
      packageId: pkg.packageId,
      origin: pkg.origin,
      total,
      seq,
      items: pkg.items.slice(seq * chunkSize, seq * chunkSize + chunkSize),
    })
  }
  return chunks
}
