/**
 * 同步域核心类型：平板（巡查半）与档案室（正式档案半 + 复核标记）各管一半。
 *
 * 关键不变量：
 * - 巡查半（PatrolHalf）只能由巡查设备（平板）写入；
 * - 正式档案半（OfficialHalf）与复核标记（ReviewMark）只能由档案室写入；
 * - 任何一头都不再整包覆盖对方，对账只认「同一来历（origin）内的版本号」。
 */

/** 两侧角色 */
export const SYNC_SIDE = {
  tablet: 'tablet',
  archive: 'archive',
} as const

export type SyncSide = (typeof SYNC_SIDE)[keyof typeof SYNC_SIDE]

/** 来历标识：一台巡查设备或一个档案室席位，如 tablet-a / archive-1 */
export type OriginId = string

/** 巡查单载荷（平板管的那一半） */
export interface PatrolPayload {
  /** 古树编号 */
  treeCode: string
  /** 巡查人 */
  inspector: string
  /** 现场长势：旺盛 / 一般 / 衰弱 / 濒危 */
  vigor: string
  /** 巡查日期 YYYY-MM-DD */
  inspectedAt: string
  /** 现场记录 */
  note: string
}

/** 正式档案载荷（档案室管的那一半） */
export interface OfficialPayload {
  /** 档案号 */
  archiveCode: string
  /** 正式结论 */
  conclusion: string
  /** 档案附注 */
  note: string
}

/** 半版本公共元数据：来历 + 单调版本号 + 修订时间。版本号只在同一来历内比较。 */
export interface HalfMeta {
  origin: OriginId
  version: number
  revisedAt: string
}

/** 巡查半 */
export interface PatrolHalf extends HalfMeta {
  data: PatrolPayload
}

/** 复核标记：档案室对正式档案给出，平板永远改不到 */
export interface ReviewMark {
  /** 复核结论标记，如：已复核 / 退回补查 / 撤档待查 */
  mark: string
  marker: string
  markedAt: string
}

/** 正式档案半（含复核标记） */
export interface OfficialHalf extends HalfMeta {
  data: OfficialPayload
  review: ReviewMark | null
}

/** 撤档标记（墓碑）：撤掉的树不物理删除，留痕拦截复活 */
export interface Tombstone {
  at: string
  by: OriginId
  reason: string
}

/** 冲突双版：来人（incoming）与档案室在档（local）各保留一版，等人定 */
export interface ConflictPair {
  incoming: PatrolHalf
  local: PatrolHalf
  since: string
}

/**
 * 一树一档的对账状态。
 * @property ack 各来历「已认下」的最新巡查版本（origin -> version），旧版据此跳过
 */
export interface SyncTree {
  treeId: string
  patrol: PatrolHalf | null
  official: OfficialHalf | null
  tombstone: Tombstone | null
  ack: Record<OriginId, number>
  conflict: ConflictPair | null
  /** 升级补登的老巡查单：只归档，永不进入对账 */
  legacy: boolean
}

/** 单条巡查项的对账结论 */
export const RECONCILE_STATUS = {
  /** 认下本次巡查最新版 */
  adopted: 'adopted',
  /** 同一来历的旧版，跳过不顶账 */
  staleSkipped: 'stale-skipped',
  /** 两边来历都改过，两版留存待人定 */
  conflictHeld: 'conflict-held',
  /** 撤档树上又冒出同一株，拦截不带回 */
  resurrectBlocked: 'resurrect-blocked',
  /** 老巡查单，只归档不对账 */
  legacySkipped: 'legacy-skipped',
} as const

export type ReconcileStatus = (typeof RECONCILE_STATUS)[keyof typeof RECONCILE_STATUS]

/** 一次对账结果（对应巡查包里的一条） */
export interface ReconcileResult {
  status: ReconcileStatus
  treeId: string
  incomingOrigin: OriginId
  incomingVersion: number
  detail: string
  at: string
}

/** 审计动作 */
export type AuditAction =
  | 'patrol-adopted'
  | 'patrol-stale-skipped'
  | 'conflict-held'
  | 'resurrect-blocked'
  | 'conflict-resolve-incoming'
  | 'conflict-resolve-local'
  | 'conflict-resolve-merge'
  | 'official-updated'
  | 'review-marked'
  | 'tree-withdrawn'
  | 'tree-reinstated'

/** 审计条目，所有对账与人工裁定都留痕 */
export interface AuditEntry {
  id: string
  at: string
  action: AuditAction
  treeId: string
  origin: OriginId
  detail: string
}

/** 巡查半落库所需端口（档案室存储实现） */
export interface ReconcilePort {
  getTree(treeId: string): Promise<SyncTree | null>
  putTree(tree: SyncTree): Promise<void>
  addAudit(entry: Omit<AuditEntry, 'id'>): Promise<void>
}
