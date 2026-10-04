/**
 * 同步域 IndexedDB 持久化（Dexie）——与业务库 gbheritagetree 完全分开的两个库：
 * - gbsync-archive：档案室那头（正式档案半、复核标记、墓碑、巡查对账副本、会话、审计、老单归档）
 * - gbsync-tablet：平板那头（巡查草稿、已封包）
 *
 * 物理隔离体现「各自管各自那半」：平板库根本没有正式档案 / 复核字段。
 */
import Dexie, { type Table } from 'dexie'
import type {
  AuditEntry,
  OriginId,
  PatrolPayload,
  ReconcilePort,
  ReconcileResult,
  SyncTree,
} from '../types/sync'
import type { PatrolItem, SessionPort, TransferSession } from '../types/transfer'
import type { LegacySheet } from '../types/legacy'
import type { LegacyPort } from './sync/legacy'
import { reconcilePatrolBatch } from './sync/reconcile'
import { nowIso, uuid } from './id'

/* ============================== 档案室库 ============================== */

class SyncArchiveDatabase extends Dexie {
  trees!: Table<SyncTree, string>
  sessions!: Table<TransferSession, string>
  audits!: Table<AuditEntry, string>
  legacySheets!: Table<LegacySheet, string>

  constructor() {
    super('gbsync-archive')
    this.version(1).stores({
      trees: 'id, legacy, patrol.origin, official.origin, tombstone',
      sessions: 'id, status',
      audits: 'id, action, treeId',
      legacySheets: 'id, registrar',
    })
  }
}

export const archiveDb = new SyncArchiveDatabase()

/** 档案室仓储：对账端口 + 传输会话端口 + 老单归档端口 */
export class ArchiveRepository implements ReconcilePort, SessionPort, LegacyPort {
  async getTree(treeId: string): Promise<SyncTree | null> {
    return (await archiveDb.trees.get(treeId)) ?? null
  }

  async putTree(tree: SyncTree): Promise<void> {
    await archiveDb.trees.put(tree)
  }

  async addAudit(entry: Omit<AuditEntry, 'id'>): Promise<void> {
    await archiveDb.audits.put({ ...entry, id: uuid('audit') })
  }

  async getSession(packageId: string): Promise<TransferSession | null> {
    return (await archiveDb.sessions.get(packageId)) ?? null
  }

  async putSession(session: TransferSession): Promise<void> {
    await archiveDb.sessions.put(session)
  }

  async reconcile(origin: OriginId, items: PatrolItem[]): Promise<ReconcileResult[]> {
    return reconcilePatrolBatch(this, origin, items, nowIso())
  }

  listTrees(): Promise<SyncTree[]> {
    return archiveDb.trees.toArray()
  }

  listSessions(): Promise<TransferSession[]> {
    return archiveDb.sessions.toArray()
  }

  listAudits(): Promise<AuditEntry[]> {
    return archiveDb.audits.toArray()
  }

  listLegacySheets(): Promise<LegacySheet[]> {
    return archiveDb.legacySheets.toArray()
  }

  async putLegacySheet(sheet: LegacySheet): Promise<void> {
    await archiveDb.legacySheets.put(sheet)
  }

  async clearAll(): Promise<void> {
    await Promise.all([archiveDb.trees.clear(), archiveDb.sessions.clear(), archiveDb.audits.clear(), archiveDb.legacySheets.clear()])
  }
}

export const archiveRepo = new ArchiveRepository()

/* =============================== 平板库 =============================== */

/** 平板本地行：巡查草稿（只含巡查半），无任何正式档案字段 */
export interface TabletDraftRow {
  /** 主键：origin + treeId */
  key: string
  origin: OriginId
  treeId: string
  version: number
  sealedVersion: number
  payload: PatrolPayload
  updatedAt: string
}

class SyncTabletDatabase extends Dexie {
  drafts!: Table<TabletDraftRow, string>

  constructor() {
    super('gbsync-tablet')
    this.version(1).stores({
      drafts: 'key, origin, treeId',
    })
  }
}

export const tabletDb = new SyncTabletDatabase()

/** 某台平板的草稿键 */
export function draftKey(origin: OriginId, treeId: string): string {
  return `${origin}::${treeId}`
}

export async function listTabletDrafts(origin: OriginId): Promise<TabletDraftRow[]> {
  return tabletDb.drafts.where('origin').equals(origin).toArray()
}

export async function putTabletDraft(row: TabletDraftRow): Promise<void> {
  await tabletDb.drafts.put(row)
}

export async function clearTabletDrafts(origin: OriginId): Promise<void> {
  const rows = await listTabletDrafts(origin)
  await tabletDb.drafts.bulkDelete(rows.map((row) => row.key))
}
