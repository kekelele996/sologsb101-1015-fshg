/**
 * 离线对账（Sync）类型定义
 *
 * 两头各自管各自那半：
 * - 平板（tablet）离线记巡查单（Survey），回办公室交巡查包；
 * - 档案室（archive）守正式档案（Tree）与复核标记（Review），按两边各自来历对账。
 *
 * 对账规则：
 * - 同一条认各自最新版（LWW per side）；
 * - 两边都改过的树先留两版等人定（conflict）；
 * - 撤掉的树要留标记（tombstone），巡查包里再冒出同一株不能带回来；
 * - 传一半失败后按那头重试，已认下那头不受影响，网络恢复后接着传（resumable）；
 * - 旧巡查单没来历，升级时按登记人补一方，老单只归档不对账（legacy）。
 */

/** 数据来历：平板 / 档案室 / 旧单（无来历） */
export type SyncOrigin = 'tablet' | 'archive' | 'legacy'

/** 巡查单对账状态 */
export type SyncState =
  | 'pending' // 平板本地待交包
  | 'transferring' // 已交包，传输中
  | 'synced' // 已认下（对账完成）
  | 'conflict' // 两边都改过，留两版等人定
  | 'rejected' // 撞墓碑：撤掉的树又冒出来，不能带回来
  | 'archived-legacy' // 旧单只归档不对账

/** 巡查包传输状态 */
export type PackageStatus = 'transferring' | 'partial' | 'completed' | 'failed'

/** 巡查包条目状态 */
export type PackageItemStatus = 'pending' | 'transferred' | 'failed'

/** 巡查包：平板回办公室交的一包巡查单 */
export interface SyncPackage {
  id: string
  /** 交包时间 */
  createdAt: string
  status: PackageStatus
  /** 总包数（条目数） */
  totalItems: number
  /** 已传条目数（断点续传依据） */
  ackedItems: number
  /** 模拟断网时，传到第几条失败（0 表示未失败） */
  failAt: number
  /** 条目明细：formId → 状态 */
  items: Record<string, PackageItemStatus>
  /** 最近一次失败原因 */
  lastError: string
}

/** 两边都改过的冲突：留两版等人定 */
export interface SyncConflict {
  id: string
  /** 冲突的古树 */
  treeId: string
  /** 冲突的巡查单 id */
  formId: string
  /** 平板那版（快照） */
  tabletVersion: Record<string, unknown>
  /** 档案室那版（快照） */
  archiveVersion: Record<string, unknown>
  createdAt: string
  status: 'pending' | 'resolved-tablet' | 'resolved-archive'
}

/** 撤掉的树要留标记：墓碑 */
export interface SyncTombstone {
  treeId: string
  removedAt: string
  reason: string
}

/** 对账结果：每条巡查单的处置 */
export interface ReconcileResult {
  formId: string
  treeId: string
  status: 'accepted' | 'conflict' | 'rejected-tombstone' | 'archived-legacy' | 'superseded'
  reason: string
}

/** 巡查单同步字段（混入 Survey） */
export interface SyncFields {
  /** 数据来历 */
  origin: SyncOrigin
  /** 登记人（旧单按登记人补一方） */
  registrar: string
  /** 单调版本号：每次修改 +1，用于 LWW */
  version: number
  /** 墓碑标记：true 表示已撤掉 */
  tombstone: boolean
  /** 对账状态 */
  syncState: SyncState
  /** 上次认下时的版本（共同祖先） */
  lastSyncedVersion: number
}
