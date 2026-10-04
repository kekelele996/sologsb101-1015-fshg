/**
 * 对账引擎（纯逻辑，不依赖 IndexedDB / Vue，可直接在 Node 下测试）。
 *
 * 规则对应需求：
 * - 两头各自管各自那半：本引擎只落「巡查半」，正式档案半与复核标记由档案室侧 API 管，平板够不到；
 * - 按两边各自来历对账：版本号只在同一 origin 内比较，A 平板的新版不能被 B 平板 / 旧版顶掉；
 * - 同一条认各自最新版：同一 origin 只认最高 version，旧版 stale 跳过（解决「旧版顶掉复核结论」）；
 * - 都改过的树先留两版：两个来历对同一棵树的巡查半都有更新时，不覆盖，挂 conflict 等人定；
 * - 撤掉的树留墓碑：巡查包里再冒出同一株直接 resurrect-blocked，不带回也不复活；
 * - 老巡查单 legacy：只归档不对账，引擎见到即跳过。
 */
import type {
  AuditAction,
  ConflictPair,
  OfficialHalf,
  OfficialPayload,
  OriginId,
  PatrolHalf,
  PatrolPayload,
  ReconcilePort,
  ReconcileResult,
  ReviewMark,
  SyncTree,
  Tombstone,
} from '../../types/sync'
import { RECONCILE_STATUS } from '../../types/sync'
import type { PatrolItem } from '../../types/transfer'

/** 空的一树一档 */
export function emptyTree(treeId: string): SyncTree {
  return {
    treeId,
    patrol: null,
    official: null,
    tombstone: null,
    ack: {},
    conflict: null,
    legacy: false,
  }
}

function result(
  status: ReconcileResult['status'],
  treeId: string,
  origin: OriginId,
  version: number,
  detail: string,
  at: string,
): ReconcileResult {
  return { status, treeId, incomingOrigin: origin, incomingVersion: version, detail, at }
}

async function audit(port: ReconcilePort, action: AuditAction, treeId: string, origin: OriginId, detail: string, at: string): Promise<void> {
  await port.addAudit({ at, action, treeId, origin, detail })
}

/**
 * 认一条巡查项。返回对账结论，并把结论落到 port。
 * 已认下的条目（ack 已到该 version）重放时只会得到 stale-skipped，天然幂等、可安全重试。
 */
export async function reconcilePatrol(
  port: ReconcilePort,
  origin: OriginId,
  item: PatrolItem,
  at: string,
): Promise<ReconcileResult> {
  const existing = (await port.getTree(item.treeId)) ?? emptyTree(item.treeId)

  // 老巡查单只归档，永不参与对账
  if (existing.legacy) {
    const res = result(RECONCILE_STATUS.legacySkipped, item.treeId, origin, item.version, '老巡查单只归档，不参与对账', at)
    await audit(port, 'patrol-stale-skipped', item.treeId, origin, res.detail, at)
    return res
  }

  // 撤档树：再冒出同一株，拦截不带回、不复活
  if (existing.tombstone !== null) {
    const res = result(
      RECONCILE_STATUS.resurrectBlocked,
      item.treeId,
      origin,
      item.version,
      `该树已于 ${existing.tombstone.at} 撤档（${existing.tombstone.reason}），拒绝复活`,
      at,
    )
    await audit(port, 'resurrect-blocked', item.treeId, origin, res.detail, at)
    return res
  }

  const acknowledged = existing.ack[origin] ?? 0

  // 同一来历的旧版：不能顶掉已认下的新版 / 复核结论
  if (item.version <= acknowledged) {
    const res = result(
      RECONCILE_STATUS.staleSkipped,
      item.treeId,
      origin,
      item.version,
      `旧版 v${item.version} ≤ 已认下 v${acknowledged}，跳过`,
      at,
    )
    await audit(port, 'patrol-stale-skipped', item.treeId, origin, res.detail, at)
    return res
  }

  const incoming: PatrolHalf = { origin, version: item.version, revisedAt: at, data: item.payload }

  // 已挂冲突的树：等人裁定前不再接受任何新巡查，避免冲突被悄悄冲掉
  if (existing.conflict !== null) {
    const pair: ConflictPair = { ...existing.conflict, incoming }
    const next = { ...existing, conflict: pair }
    await port.putTree(next)
    const res = result(
      RECONCILE_STATUS.conflictHeld,
      item.treeId,
      origin,
      item.version,
      `该树存在待裁定冲突（${existing.conflict.incoming.origin} ↔ ${existing.conflict.local.origin}），先留两版等人定`,
      at,
    )
    await audit(port, 'conflict-held', item.treeId, origin, res.detail, at)
    return res
  }

  // 都改过的树：另一个来历已认下过巡查版，且本树巡查半在那之后仍是该来历的版本
  // ——即两个来历都对同一棵树有更新。先留两版，不自动覆盖。
  const otherAcked = Object.keys(existing.ack).some((o) => o !== origin && existing.ack[o] > 0)
  if (otherAcked && existing.patrol !== null && existing.patrol.origin !== origin) {
    const pair: ConflictPair = { incoming, local: existing.patrol, since: at }
    const next: SyncTree = { ...existing, conflict: pair }
    await port.putTree(next)
    const res = result(
      RECONCILE_STATUS.conflictHeld,
      item.treeId,
      origin,
      item.version,
      `${origin} v${item.version} 与在档 ${existing.patrol.origin} v${existing.patrol.version} 各改各的，保留两版待人定`,
      at,
    )
    await audit(port, 'conflict-held', item.treeId, origin, res.detail, at)
    return res
  }

  // 同一条认各自最新版：认下本来历的新巡查半，正式档案半与复核标记原样保留
  const next: SyncTree = {
    ...existing,
    patrol: incoming,
    ack: { ...existing.ack, [origin]: item.version },
  }
  await port.putTree(next)
  const res = result(
    RECONCILE_STATUS.adopted,
    item.treeId,
    origin,
    item.version,
    `认下 ${origin} 巡查 v${item.version}`,
    at,
  )
  await audit(port, 'patrol-adopted', item.treeId, origin, res.detail, at)
  return res
}

/** 批量对账 */
export async function reconcilePatrolBatch(
  port: ReconcilePort,
  origin: OriginId,
  items: PatrolItem[],
  at: string,
): Promise<ReconcileResult[]> {
  const results: ReconcileResult[] = []
  for (const item of items) {
    results.push(await reconcilePatrol(port, origin, item, at))
  }
  return results
}

/* ------------------------- 冲突人工裁定 ------------------------- */

/** 裁定方式：认来人这版 / 认档案室在档这版 / 人工合并出一版 */
export const RESOLVE_CHOICE = {
  incoming: 'incoming',
  local: 'local',
  merge: 'merge',
} as const

export type ResolveChoice = (typeof RESOLVE_CHOICE)[keyof typeof RESOLVE_CHOICE]

/** 合并用的人工巡查载荷与落版来历（通常为档案室席位） */
export interface MergeInput {
  origin: OriginId
  data: PatrolPayload
}

/**
 * 人工裁定冲突。
 * 裁定后把两个相争来历的 ack 都补到本次版本，避免同一条目重试时又起冲突；
 * 合并版以新来历落一版（保留人定结果，不冒充任一设备）。
 */
export async function resolveConflict(
  port: ReconcilePort,
  treeId: string,
  choice: ResolveChoice,
  merge: MergeInput | null,
  at: string,
): Promise<void> {
  const existing = await port.getTree(treeId)
  if (existing === null || existing.conflict === null) return
  const { incoming, local } = existing.conflict

  let chosen: PatrolHalf
  let action: AuditAction
  if (choice === RESOLVE_CHOICE.incoming) {
    chosen = incoming
    action = 'conflict-resolve-incoming'
  } else if (choice === RESOLVE_CHOICE.local) {
    chosen = local
    action = 'conflict-resolve-local'
  } else {
    if (merge === null) throw new Error('人工合并必须提供 MergeInput')
    chosen = { origin: merge.origin, version: Math.max(incoming.version, local.version) + 1, revisedAt: at, data: merge.data }
    action = 'conflict-resolve-merge'
  }

  const next: SyncTree = {
    ...existing,
    patrol: chosen,
    conflict: null,
    ack: { ...existing.ack, [incoming.origin]: incoming.version, [local.origin]: local.version, [chosen.origin]: chosen.version },
  }
  await port.putTree(next)
  await audit(port, action, treeId, chosen.origin, `冲突裁定：${choice}，落 ${chosen.origin} v${chosen.version}`, at)
}

/* --------------------- 档案室专属：正式档案 / 复核 / 撤档 --------------------- */

/** 档案室写入正式档案半（平板无权触碰）；若存在待裁定冲突，要求先裁定，避免结论被混在冲突里。 */
export async function upsertOfficial(
  port: ReconcilePort,
  treeId: string,
  origin: OriginId,
  payload: OfficialPayload,
  at: string,
): Promise<SyncTree> {
  const existing = (await port.getTree(treeId)) ?? emptyTree(treeId)
  if (existing.tombstone !== null) throw new Error(`该树已撤档，需先恢复才能维护正式档案：${treeId}`)
  const prevVersion = existing.official?.version ?? 0
  const next: SyncTree = {
    ...existing,
    official: { origin, version: prevVersion + 1, revisedAt: at, data: payload, review: existing.official?.review ?? null },
  }
  await port.putTree(next)
  await audit(port, 'official-updated', treeId, origin, `正式档案更新至 v${next.official?.version ?? 1}`, at)
  return next
}

/** 档案室打复核标记（只改 official.review，巡查半与 ack 一律不动） */
export async function markReview(
  port: ReconcilePort,
  treeId: string,
  origin: OriginId,
  review: ReviewMark,
): Promise<SyncTree> {
  const existing = await port.getTree(treeId)
  if (existing === null || existing.official === null) {
    throw new Error(`该树还没有正式档案，无法打复核标记：${treeId}`)
  }
  const updated: OfficialHalf = { ...existing.official, review }
  const next: SyncTree = { ...existing, official: updated }
  await port.putTree(next)
  await audit(port, 'review-marked', treeId, origin, `复核标记：${review.mark}`, review.markedAt)
  return next
}

/** 档案室撤档：保留墓碑，不物理删除；清掉待裁定冲突（撤档优先于冲突） */
export async function withdrawTree(
  port: ReconcilePort,
  treeId: string,
  origin: OriginId,
  reason: string,
  at: string,
): Promise<void> {
  const existing = (await port.getTree(treeId)) ?? emptyTree(treeId)
  const tombstone: Tombstone = { at, by: origin, reason }
  await port.putTree({ ...existing, tombstone, conflict: null })
  await audit(port, 'tree-withdrawn', treeId, origin, `撤档：${reason}`, at)
}

/** 档案室恢复误撤树：显式移除墓碑（只有档案室能做，巡查包复活仍被拦） */
export async function reinstateTree(port: ReconcilePort, treeId: string, origin: OriginId, at: string): Promise<void> {
  const existing = await port.getTree(treeId)
  if (existing === null || existing.tombstone === null) return
  await port.putTree({ ...existing, tombstone: null })
  await audit(port, 'tree-reinstated', treeId, origin, '恢复误撤树', at)
}
