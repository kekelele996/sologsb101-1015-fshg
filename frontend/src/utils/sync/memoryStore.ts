/**
 * 内存版同步存储：同时实现对账、传输会话、老单归档三个端口。
 * 用于 Node 单测与纯逻辑演示；浏览器侧另有 Dexie 持久化实现（syncDb.ts）。
 */
import type {
  AuditEntry,
  OriginId,
  ReconcilePort,
  ReconcileResult,
  SyncTree,
} from '../../types/sync'
import type { PatrolItem, SessionPort, TransferSession } from '../../types/transfer'
import type { LegacyPort } from './legacy'
import { reconcilePatrolBatch } from './reconcile'
import { uuid } from '../id'

export class MemorySyncStore implements ReconcilePort, SessionPort, LegacyPort {
  trees: Map<string, SyncTree> = new Map()
  sessions: Map<string, TransferSession> = new Map()
  audits: AuditEntry[] = []

  async getTree(treeId: string): Promise<SyncTree | null> {
    const found = this.trees.get(treeId)
    return found ? structuredClone(found) : null
  }

  async putTree(tree: SyncTree): Promise<void> {
    this.trees.set(tree.treeId, structuredClone(tree))
  }

  async addAudit(entry: Omit<AuditEntry, 'id'>): Promise<void> {
    this.audits.push({ ...entry, id: uuid('audit') })
  }

  async getSession(packageId: string): Promise<TransferSession | null> {
    const found = this.sessions.get(packageId)
    return found ? structuredClone(found) : null
  }

  async putSession(session: TransferSession): Promise<void> {
    this.sessions.set(session.packageId, structuredClone(session))
  }

  async reconcile(origin: OriginId, items: PatrolItem[]): Promise<ReconcileResult[]> {
    return reconcilePatrolBatch(this, origin, items, new Date().toISOString())
  }

  /** 测试辅助：直接种一棵在档树 */
  seed(tree: SyncTree): void {
    this.trees.set(tree.treeId, structuredClone(tree))
  }
}
