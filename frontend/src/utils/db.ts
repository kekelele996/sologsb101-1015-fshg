/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbheritagetree
 * - 含数据结构版本号与 v1 → v2 → v3 升级迁移逻辑
 * - v3：巡查单加来历 / 登记人 / 版本 / 墓碑 / 对账状态；新增巡查包、冲突、墓碑表
 * - 提供各表增删改查、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie'
import type { Tree } from '../types/tree'
import type { Survey } from '../types/survey'
import type { Measure, MeasureState } from '../types/measure'
import type { Support } from '../types/support'
import type { Review } from '../types/review'
import type { SyncConflict, SyncPackage, SyncTombstone } from '../types/sync'
import { nowIso, today } from './id'
import { seedDatabase } from './seed'

/** 数据库名 */
export const DB_NAME = 'gbheritagetree'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3

/** 数据行结构修订号 */
export const ROW_REVISION = 3

class HeritageTreeDatabase extends Dexie {
  trees!: Table<Tree, string>
  surveys!: Table<Survey, string>
  measures!: Table<Measure, string>
  supports!: Table<Support, string>
  reviews!: Table<Review, string>
  /** 档案室：平板交来的巡查单（待对账） */
  transferredForms!: Table<Survey, string>
  /** 两边都改过的冲突（留两版等人定） */
  syncConflicts!: Table<SyncConflict, string>
  /** 撤掉的树要留标记（墓碑） */
  syncTombstones!: Table<SyncTombstone, string>
  /** 巡查包：平板回办公室交的一包巡查单 */
  syncPackages!: Table<SyncPackage, string>

  constructor() {
    super(DB_NAME)

    // ---------- v1：初版结构 ----------
    this.version(1).stores({
      trees: 'id, code, species, protectLevel, ageYears, createdAt',
      surveys: 'id, treeId, date',
      measures: 'id, treeId, type, state, date',
      supports: 'id, treeId, type, installDate',
      reviews: 'id, treeId, date, vigor',
    })

    // ---------- v2：补齐索引与回写字段，并迁移历史数据 ----------
    this.version(2)
      .stores({
        trees: 'id, code, species, protectLevel, ageYears, createdAt, updatedAt, owner',
        // 复合索引 [treeId+date]：按古树 + 日期快速取检查记录
        surveys: 'id, treeId, [treeId+date], date, siteNote',
        measures: 'id, treeId, type, state, date, operator',
        supports: 'id, treeId, type, installDate, lastCheckDate',
        reviews: 'id, treeId, date, vigor, trend',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('trees'),
          tx.table('surveys'),
          tx.table('measures'),
          tx.table('supports'),
          tx.table('reviews'),
        ]
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso()
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt
          })
        }
        // 迁移 2：古树补齐「最近复壮日期」
        await tx.table('trees').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.lastMeasureDate !== 'string') row.lastMeasureDate = ''
        })
        // 迁移 3：复评补齐「后续措施」
        await tx.table('reviews').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.followUp !== 'string') row.followUp = ''
        })
        // 迁移 4：加固件补齐「最近检查日期」
        await tx.table('supports').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.lastCheckDate !== 'string') row.lastCheckDate = ''
          if (typeof row.checkCycleMon !== 'number') row.checkCycleMon = 12
        })
      })

    // ---------- v3：巡查单加来历 / 登记人 / 版本 / 墓碑 / 对账状态，新增对账表 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        trees: 'id, code, species, protectLevel, ageYears, createdAt, updatedAt, owner',
        surveys: 'id, treeId, [treeId+date], date, siteNote, origin, syncState, registrar',
        measures: 'id, treeId, type, state, date, operator',
        supports: 'id, treeId, type, installDate, lastCheckDate',
        reviews: 'id, treeId, date, vigor, trend',
        transferredForms: 'id, treeId, origin, syncState, date',
        syncConflicts: 'id, treeId, formId, status',
        syncTombstones: 'treeId, removedAt',
        syncPackages: 'id, status, createdAt',
      })
      .upgrade(async (tx) => {
        // 旧巡查单没来历：升级时按登记人补一方，老单只归档不对账
        const tabletOfficers = new Set(['张磊', '王芳', '李强'])
        await tx.table('surveys').toCollection().modify((row: Record<string, unknown>) => {
          const registrar = typeof row.registrar === 'string' ? row.registrar : ''
          const hasRegistrar = registrar.trim() !== ''
          // 按登记人补一方：登记人是平板巡查班的归平板，否则归档案室
          const origin = hasRegistrar ? (tabletOfficers.has(registrar) ? 'tablet' : 'archive') : 'legacy'
          row.origin = origin
          row.registrar = registrar
          row.version = 1
          row.tombstone = false
          row.syncState = 'archived-legacy' // 老单只归档不对账
          row.lastSyncedVersion = 1
        })
      })
  }
}

export const db = new HeritageTreeDatabase()

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open()
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.trees.count()) === 0) {
        await seedDatabase()
      }
    })()
  }
  return initPromise
}

/* -------------------------------- 古树 -------------------------------- */

export async function listTrees(): Promise<Tree[]> {
  const rows = await db.trees.toArray()
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

export async function getTree(id: string): Promise<Tree | undefined> {
  return db.trees.get(id)
}

export async function putTree(row: Tree): Promise<void> {
  await db.trees.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/** 删除古树并级联清理其检查、措施、加固与复评记录 */
export async function removeTree(id: string): Promise<void> {
  await db.transaction('rw', db.trees, db.surveys, db.measures, db.supports, db.reviews, async () => {
    await db.surveys.where('treeId').equals(id).delete()
    await db.measures.where('treeId').equals(id).delete()
    await db.supports.where('treeId').equals(id).delete()
    await db.reviews.where('treeId').equals(id).delete()
    await db.trees.delete(id)
  })
}

/* ------------------------------ 树体检查 ------------------------------ */

export async function listSurveys(): Promise<Survey[]> {
  const rows = await db.surveys.toArray()
  return rows.sort((a, b) => a.treeId.localeCompare(b.treeId) || a.date.localeCompare(b.date))
}

export async function listSurveysByTree(treeId: string): Promise<Survey[]> {
  const rows = await db.surveys.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

export async function putSurvey(row: Survey): Promise<void> {
  await db.surveys.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeSurvey(id: string): Promise<void> {
  await db.surveys.delete(id)
}

/* ------------------------------ 复壮措施 ------------------------------ */

export async function listMeasures(): Promise<Measure[]> {
  const rows = await db.measures.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listMeasuresByTree(treeId: string): Promise<Measure[]> {
  const rows = await db.measures.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

/**
 * 写入复壮措施。
 * 措施状态为「已完成」时，回写古树的最近复壮日期（仅当本次日期更新时）。
 */
export async function putMeasure(row: Measure): Promise<void> {
  await db.transaction('rw', db.trees, db.measures, async () => {
    await db.measures.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
    if (row.state !== '已完成') return
    const tree = await db.trees.get(row.treeId)
    if (!tree) return
    if (tree.lastMeasureDate >= row.date) return
    await db.trees.update(tree.id, { lastMeasureDate: row.date, updatedAt: nowIso() })
  })
}

export async function removeMeasure(id: string): Promise<void> {
  await db.measures.delete(id)
}

/** 批量修改措施状态；改为「已完成」时同步回写古树最近复壮日期 */
export async function batchSetMeasureState(ids: string[], state: MeasureState): Promise<number> {
  if (ids.length === 0) return 0
  const rows = await db.measures.bulkGet(ids)
  const list = rows.filter((row): row is Measure => row !== undefined)
  for (const row of list) {
    await putMeasure({ ...row, state })
  }
  return list.length
}

/* ------------------------------ 加固件 ------------------------------ */

export async function listSupports(): Promise<Support[]> {
  const rows = await db.supports.toArray()
  return rows.sort((a, b) => a.installDate.localeCompare(b.installDate))
}

export async function listSupportsByTree(treeId: string): Promise<Support[]> {
  return db.supports.where('treeId').equals(treeId).toArray()
}

export async function putSupport(row: Support): Promise<void> {
  await db.supports.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeSupport(id: string): Promise<void> {
  await db.supports.delete(id)
}

/** 登记本次检查：把最近检查日期置为给定日期（默认今天） */
export async function markSupportChecked(id: string, date = today()): Promise<void> {
  await db.supports.update(id, { lastCheckDate: date, updatedAt: nowIso() })
}

/* ------------------------------ 长势复评 ------------------------------ */

export async function listReviews(): Promise<Review[]> {
  const rows = await db.reviews.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listReviewsByTree(treeId: string): Promise<Review[]> {
  const rows = await db.reviews.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

export async function putReview(row: Review): Promise<void> {
  await db.reviews.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeReview(id: string): Promise<void> {
  await db.reviews.delete(id)
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  trees: Tree[]
  surveys: Survey[]
  measures: Measure[]
  supports: Support[]
  reviews: Review[]
  transferredForms?: Survey[]
  syncConflicts?: SyncConflict[]
  syncTombstones?: SyncTombstone[]
  syncPackages?: SyncPackage[]
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [trees, surveys, measures, supports, reviews, transferredForms, syncConflicts, syncTombstones, syncPackages] =
    await Promise.all([
      db.trees.toArray(),
      db.surveys.toArray(),
      db.measures.toArray(),
      db.supports.toArray(),
      db.reviews.toArray(),
      db.transferredForms.toArray(),
      db.syncConflicts.toArray(),
      db.syncTombstones.toArray(),
      db.syncPackages.toArray(),
    ])
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    trees,
    surveys,
    measures,
    supports,
    reviews,
    transferredForms,
    syncConflicts,
    syncTombstones,
    syncPackages,
  }
}

/** 用快照覆盖整库（导入存档） */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.trees,
      db.surveys,
      db.measures,
      db.supports,
      db.reviews,
      db.transferredForms,
      db.syncConflicts,
      db.syncTombstones,
      db.syncPackages,
    ],
    async () => {
      await Promise.all([
        db.trees.clear(),
        db.surveys.clear(),
        db.measures.clear(),
        db.supports.clear(),
        db.reviews.clear(),
        db.transferredForms.clear(),
        db.syncConflicts.clear(),
        db.syncTombstones.clear(),
        db.syncPackages.clear(),
      ])
      await db.trees.bulkPut(snapshot.trees.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.surveys.bulkPut(snapshot.surveys.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.measures.bulkPut(snapshot.measures.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.supports.bulkPut(snapshot.supports.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.reviews.bulkPut(snapshot.reviews.map((row) => ({ ...row, revision: ROW_REVISION })))
      if (snapshot.transferredForms) await db.transferredForms.bulkPut(snapshot.transferredForms)
      if (snapshot.syncConflicts) await db.syncConflicts.bulkPut(snapshot.syncConflicts)
      if (snapshot.syncTombstones) await db.syncTombstones.bulkPut(snapshot.syncTombstones)
      if (snapshot.syncPackages) await db.syncPackages.bulkPut(snapshot.syncPackages)
    },
  )
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.trees,
      db.surveys,
      db.measures,
      db.supports,
      db.reviews,
      db.transferredForms,
      db.syncConflicts,
      db.syncTombstones,
      db.syncPackages,
    ],
    async () => {
      await Promise.all([
        db.trees.clear(),
        db.surveys.clear(),
        db.measures.clear(),
        db.supports.clear(),
        db.reviews.clear(),
        db.transferredForms.clear(),
        db.syncConflicts.clear(),
        db.syncTombstones.clear(),
        db.syncPackages.clear(),
      ])
    },
  )
  await seedDatabase()
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [trees, surveys, measures, supports, reviews, transferredForms, syncConflicts, syncTombstones, syncPackages] =
    await Promise.all([
      db.trees.count(),
      db.surveys.count(),
      db.measures.count(),
      db.supports.count(),
      db.reviews.count(),
      db.transferredForms.count(),
      db.syncConflicts.count(),
      db.syncTombstones.count(),
      db.syncPackages.count(),
    ])
  return { trees, surveys, measures, supports, reviews, transferredForms, syncConflicts, syncTombstones, syncPackages }
}

/* ---------------------------- 对账表操作 ---------------------------- */

/** 撤掉古树：写墓碑标记（不物理删除，留标记） */
export async function addTombstone(treeId: string, reason: string): Promise<void> {
  await db.syncTombstones.put({ treeId, removedAt: nowIso(), reason })
}

/** 古树是否已被撤掉（撞墓碑：巡查包里再冒出同一株不能带回来） */
export async function isTombstoned(treeId: string): Promise<boolean> {
  const row = await db.syncTombstones.get(treeId)
  return row !== undefined
}

/** 列出全部墓碑 */
export async function listTombstones(): Promise<SyncTombstone[]> {
  return db.syncTombstones.toArray()
}

/** 列出未解决的冲突 */
export async function listPendingConflicts(): Promise<SyncConflict[]> {
  return db.syncConflicts.where('status').equals('pending').toArray()
}

/** 列出全部巡查包（按创建时间倒序） */
export async function listPackages(): Promise<SyncPackage[]> {
  const rows = await db.syncPackages.toArray()
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** 档案室复核修正巡查单：版本 +1，origin 标记为档案室 */
export async function archiveReviewSurvey(row: Survey): Promise<void> {
  await db.surveys.put({
    ...row,
    origin: 'archive',
    version: row.version + 1,
    lastSyncedVersion: row.lastSyncedVersion,
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  })
}
