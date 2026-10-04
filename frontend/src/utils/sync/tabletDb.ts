/**
 * 平板端离线数据库（Dexie 封装）
 *
 * 山上没信号，巡查班平板离线记巡查单，数据只存在平板本地这个独立库里；
 * 回办公室交巡查包时，再把条目逐条传到档案室库（gbheritagetree）。
 * 两头各自管各自那半：平板库只装巡查单，档案室库装正式档案与复核标记。
 */
import Dexie, { type Table } from 'dexie'
import type { Survey } from '../../types/survey'

/** 平板数据库名（与档案室库 gbheritagetree 物理隔离） */
export const TABLET_DB_NAME = 'gbheritagetree-tablet'

/** 平板数据库结构版本号 */
export const TABLET_DB_VERSION = 1

class TabletDatabase extends Dexie {
  /** 平板离线巡查单 */
  patrolForms!: Table<Survey, string>

  constructor() {
    super(TABLET_DB_NAME)
    this.version(TABLET_DB_VERSION).stores({
      // 巡查单：按古树 + 日期检索，syncState 标记是否已交包
      patrolForms: 'id, treeId, [treeId+date], date, syncState, origin, registrar',
    })
  }
}

export const tabletDb = new TabletDatabase()

let initPromise: Promise<void> | null = null

/** 打开平板数据库（幂等） */
export function initTabletDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = tabletDb.open().then(() => undefined)
  }
  return initPromise
}

/** 列出平板全部巡查单（按日期倒序） */
export async function listPatrolForms(): Promise<Survey[]> {
  const rows = await tabletDb.patrolForms.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

/** 按古树列出平板巡查单 */
export async function listPatrolFormsByTree(treeId: string): Promise<Survey[]> {
  return tabletDb.patrolForms.where('treeId').equals(treeId).toArray()
}

/** 写入平板巡查单（新增或编辑） */
export async function putPatrolForm(row: Survey): Promise<void> {
  await tabletDb.patrolForms.put(row)
}

/** 删除平板巡查单 */
export async function removePatrolForm(id: string): Promise<void> {
  await tabletDb.patrolForms.delete(id)
}

/** 统计平板待交包（pending）巡查单数 */
export async function countPendingForms(): Promise<number> {
  return tabletDb.patrolForms.where('syncState').equals('pending').count()
}
