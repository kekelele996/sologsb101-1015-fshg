/**
 * 同步域演示数据（幂等播种）：
 * 分别在档案室库、平板库、老单池里布置好「各管一半 / 撤档 / 双设备冲突 / 旧版 / 老单」场景。
 * 不影响业务库 gbheritagetree。
 */
import type { SyncTree } from '../types/sync'
import { archiveRepo, archiveDb, tabletDb, type TabletDraftRow } from './syncDb'
import type { LegacySheet } from '../types/legacy'
import type { PatrolPayload } from '../types/sync'
import { nowIso } from './id'

const SEED_FLAG_KEY = 'gbsync:seeded:v1'

const T0 = '2026-10-01T08:00:00.000Z'

function p(inspector: string, note: string, code: string, vigor = '一般'): PatrolPayload {
  return { treeCode: code, inspector, vigor, inspectedAt: '2026-10-01', note }
}

/** 档案室在档树：覆盖对账各分支 */
function seedTrees(): SyncTree[] {
  return [
    {
      // 档案室有正式档案 + 已复核；平板已认 v1 并将交 v2 → 认下巡查新版，复核标记不动
      treeId: 'sync-001',
      patrol: { origin: 'tablet-a', version: 1, revisedAt: T0, data: p('王护', '月初巡查：正常', '京-01-0007') },
      official: {
        origin: 'archive-1',
        version: 1,
        revisedAt: T0,
        data: { archiveCode: '档-0007', conclusion: '长势一般，按计划养护', note: '' },
        review: { mark: '已复核', marker: '李档', markedAt: T0 },
      },
      tombstone: null,
      ack: { 'tablet-a': 1 },
      conflict: null,
      legacy: false,
    },
    {
      // 已撤档树：巡查包里再有同一株 → resurrect-blocked
      treeId: 'sync-002',
      patrol: { origin: 'tablet-a', version: 1, revisedAt: T0, data: p('王护', '撤档前巡查', '京-02-0113') },
      official: {
        origin: 'archive-1',
        version: 1,
        revisedAt: T0,
        data: { archiveCode: '档-0113', conclusion: '误登非名木', note: '' },
        review: { mark: '撤档待查', marker: '李档', markedAt: T0 },
      },
      tombstone: { at: T0, by: 'archive-1', reason: '误登非古树，撤档' },
      ack: { 'tablet-a': 1 },
      conflict: null,
      legacy: false,
    },
    {
      // 双设备各巡查过：已认下 tablet-a v1，封包里 tablet-b v1 → conflict-held
      treeId: 'sync-003',
      patrol: { origin: 'tablet-a', version: 1, revisedAt: T0, data: p('王护', 'A 组：东侧冠幅正常', '京-05-0246') },
      official: null,
      tombstone: null,
      ack: { 'tablet-a': 1 },
      conflict: null,
      legacy: false,
    },
    {
      // 档案室从未见过的新树：平板交来 → adopted（新建）
      treeId: 'sync-004',
      patrol: null,
      official: null,
      tombstone: null,
      ack: {},
      conflict: null,
      legacy: false,
    },
    {
      // 已认下 tablet-a v2，包里若夹 v1 旧条 → stale-skipped
      treeId: 'sync-005',
      patrol: { origin: 'tablet-a', version: 2, revisedAt: T0, data: p('王护', '最新 v2：叶色正常', '京-03-0301') },
      official: null,
      tombstone: null,
      ack: { 'tablet-a': 2 },
      conflict: null,
      legacy: false,
    },
  ]
}

/** 平板草稿（按设备）：key=origin::treeId */
function seedTabletDrafts(): TabletDraftRow[] {
  const rows: Array<[string, string, number, number, PatrolPayload]> = [
    ['tablet-a', 'sync-001', 2, 0, p('王护', '下山前新巡查：有少量落叶（v2）', '京-01-0007')],
    ['tablet-a', 'sync-002', 2, 0, p('王护', '下趟又冒头：这株其实还在？（v2）', '京-02-0113')],
    ['tablet-b', 'sync-003', 1, 0, p('赵巡', 'B 组独立巡查：西侧倾斜 6°（另一个来历）', '京-05-0246', '衰弱')],
    ['tablet-a', 'sync-004', 1, 0, p('王护', '新发现一株古树，巡查建档', '京-09-0909')],
    // 夹在包里的旧条：版本 1 低于已认下的 2
    ['tablet-a', 'sync-005', 1, 0, p('王护', '旧版 v1：不应顶账', '京-03-0301')],
  ]
  return rows.map(([origin, treeId, version, sealedVersion, payload]) => ({
    key: `${origin}::${treeId}`,
    origin,
    treeId,
    version,
    sealedVersion,
    payload,
    updatedAt: nowIso(),
  }))
}

/** 待升级的老巡查单：一条登记人能映射、一条不能 */
function seedLegacySheets(): LegacySheet[] {
  return [
    { id: 'legacy-2019-01', registrar: '王护', payload: p('王护', '2019 年纸质老单录入', '京-01-0007'), recordedAt: '2019-05-01' },
    { id: 'legacy-2018-02', registrar: '退休老周', payload: p('退休老周', '登记人已不在册的老单', '京-02-0113'), recordedAt: '2018-03-02' },
  ]
}

/** 播种同步演示数据（幂等）；force=true 时先清空再播 */
export async function seedSyncDemo(force = false): Promise<void> {
  await archiveDb.open()
  const already = window.localStorage.getItem(SEED_FLAG_KEY)
  if (already !== null && !force) return
  if (force) await archiveRepo.clearAll()

  await archiveDb.transaction('rw', archiveDb.trees, archiveDb.legacySheets, async () => {
    await archiveDb.trees.bulkPut(seedTrees())
    await archiveDb.legacySheets.bulkPut(seedLegacySheets())
  })
  await tabletDb.drafts.bulkPut(seedTabletDrafts())

  window.localStorage.setItem(SEED_FLAG_KEY, nowIso())
}

export const SYNC_SEED_FLAG_KEY = SEED_FLAG_KEY
