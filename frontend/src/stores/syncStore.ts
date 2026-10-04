/**
 * 同步中心状态（Pinia）：串起平板（巡查半）与档案室（正式档案半+复核）两侧。
 * 页面只读 store，写操作都收敛在这里；纯逻辑来自 utils/sync/*。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  AuditEntry,
  OfficialPayload,
  OriginId,
  PatrolPayload,
  ReconcileResult,
  ReviewMark,
  SyncTree,
} from '../types/sync'
import type { LegacySheet, LegacyUpgradeResult } from '../types/legacy'
import type { ChunkAck, PackageChunk, PatrolPackage, TransferSession } from '../types/transfer'
import {
  RESOLVE_CHOICE,
  markReview,
  reinstateTree,
  resolveConflict,
  upsertOfficial,
  withdrawTree,
  type ResolveChoice,
} from '../utils/sync/reconcile'
import {
  chunkPackage,
  createTabletState,
  saveDraft,
  sealPackage,
  type TabletState,
} from '../utils/sync/tablet'
import { receiveChunk, resumePackage } from '../utils/sync/transfer'
import { upgradeLegacySheets } from '../utils/sync/legacy'
import {
  archiveDb,
  archiveRepo,
  clearTabletDrafts,
  draftKey,
  listTabletDrafts,
  putTabletDraft,
  tabletDb,
  type TabletDraftRow,
} from '../utils/syncDb'
import { seedSyncDemo } from '../utils/syncSeed'
import { nowIso } from '../utils/id'

export const TABLET_ORIGINS: OriginId[] = ['tablet-a', 'tablet-b']
export const ARCHIVE_ORIGIN: OriginId = 'archive-1'

/** 登记人 -> 来历：老单升级补一方（界面可为陌生登记人补映射，绝不自动猜） */
const registrarOrigin = ref<Record<string, OriginId>>({
  王护: 'tablet-a',
  赵巡: 'tablet-b',
})

/** 一片几条巡查单（演示断一半用，调小便于观察） */
const CHUNK_SIZE = 2

interface SentPackage {
  pkg: PatrolPackage
  chunks: PackageChunk[]
  sealedAt: string
}

export const useSyncStore = defineStore('sync', () => {
  const trees = ref<SyncTree[]>([])
  const sessions = ref<TransferSession[]>([])
  const audits = ref<AuditEntry[]>([])
  const legacySheets = ref<LegacySheet[]>([])
  const tabletDrafts = ref<TabletDraftRow[]>([])
  const sentPackages = ref<SentPackage[]>([])

  const currentOrigin = ref<OriginId>(TABLET_ORIGINS[0])
  const online = ref(true)
  const ready = ref(false)
  const busy = ref(false)
  const lastResults = ref<ReconcileResult[]>([])
  const lastUpgrade = ref<LegacyUpgradeResult | null>(null)
  const lastError = ref('')

  const conflicts = computed<SyncTree[]>(() => trees.value.filter((tree) => tree.conflict !== null))
  const tombstones = computed<SyncTree[]>(() => trees.value.filter((tree) => tree.tombstone !== null))
  const legacyTrees = computed<SyncTree[]>(() => trees.value.filter((tree) => tree.legacy))

  /* ------------------------------ 装载 ------------------------------ */

  async function init(): Promise<void> {
    if (ready.value) return
    await archiveDb.open()
    await seedSyncDemo(false)
    await refresh()
    ready.value = true
  }

  async function reseed(): Promise<void> {
    busy.value = true
    try {
      await clearTabletDrafts('tablet-a')
      await clearTabletDrafts('tablet-b')
      window.localStorage.removeItem('gbsync:seeded:v1')
      await seedSyncDemo(true)
      sentPackages.value = []
      lastResults.value = []
      lastUpgrade.value = null
      await refresh()
    } finally {
      busy.value = false
    }
  }

  async function refresh(): Promise<void> {
    const [treeRows, sessionRows, auditRows, legacyRows, draftRows] = await Promise.all([
      archiveRepo.listTrees(),
      archiveRepo.listSessions(),
      archiveRepo.listAudits(),
      archiveRepo.listLegacySheets(),
      listTabletDrafts(currentOrigin.value),
    ])
    trees.value = treeRows.sort((a, b) => a.treeId.localeCompare(b.treeId))
    sessions.value = sessionRows.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    audits.value = auditRows.sort((a, b) => b.at.localeCompare(a.at))
    legacySheets.value = legacyRows
    tabletDrafts.value = draftRows.sort((a, b) => a.treeId.localeCompare(b.treeId))
  }

  function switchOrigin(origin: OriginId): void {
    currentOrigin.value = origin
    lastError.value = ''
    void refresh()
  }

  function setOnline(value: boolean): void {
    online.value = value
  }

  /* --------------------------- 平板：巡查半 --------------------------- */

  async function saveTabletDraft(treeId: string, payload: PatrolPayload): Promise<void> {
    const rows = await listTabletDrafts(currentOrigin.value)
    const state = loadTabletState(rows)
    saveDraft(state, treeId, payload)
    await persistTabletState(state)
    await refresh()
  }

  function loadTabletState(rows: TabletDraftRow[]): TabletState {
    const state = createTabletState(currentOrigin.value)
    rows.forEach((row) => {
      state.drafts[row.treeId] = {
        treeId: row.treeId,
        version: row.version,
        payload: row.payload,
        sealedVersion: row.sealedVersion,
        updatedAt: row.updatedAt,
      }
    })
    return state
  }

  async function persistTabletState(state: TabletState): Promise<void> {
    await tabletDb.transaction('rw', tabletDb.drafts, async () => {
      for (const draft of Object.values(state.drafts)) {
        await putTabletDraft({
          key: draftKey(state.origin, draft.treeId),
          origin: state.origin,
          treeId: draft.treeId,
          version: draft.version,
          sealedVersion: draft.sealedVersion,
          payload: draft.payload,
          updatedAt: draft.updatedAt,
        })
      }
    })
  }

  /** 封巡查包（只装当前设备未交更新），暂存待发 */
  async function sealCurrentPackage(): Promise<PatrolPackage | null> {
    const rows = await listTabletDrafts(currentOrigin.value)
    const state = loadTabletState(rows)
    const pkg = sealPackage(state)
    await persistTabletState(state)
    await refresh()
    if (pkg === null) return null
    sentPackages.value.push({ pkg, chunks: chunkPackage(pkg, CHUNK_SIZE), sealedAt: pkg.sealedAt })
    return pkg
  }

  /* --------------------------- 传输：分片 + 续传 --------------------------- */

  /** 投递一片：离线开关关闭时直接断网（片不落接收端） */
  async function deliver(chunk: PackageChunk): Promise<ChunkAck> {
    if (!online.value) {
      throw new Error('山上 / 链路无信号：本片未送达，已认下的片不受影响')
    }
    return receiveChunk(archiveRepo, chunk)
  }

  /** 发送某个已封包：遇到断网会停在断点，恢复后续传同一包 */
  async function sendPackageToArchive(pkg: PatrolPackage): Promise<void> {
    busy.value = true
    lastError.value = ''
    try {
      const entry = sentPackages.value.find((item) => item.pkg.packageId === pkg.packageId)
      const chunks = entry?.chunks ?? chunkPackage(pkg, CHUNK_SIZE)
      const session = await archiveRepo.getSession(pkg.packageId)
      const acks = session ? Object.values(session.acks) : []
      if (session?.status === 'complete') {
        lastResults.value = acks.flatMap((ack) => ack.results)
        await refresh()
        return
      }
      // resumePackage 内部按接收端会话只投未确认片；断网 throw 时已认片保留
      const outcome = await resumePackage(archiveRepo, chunks, (c) => deliver(c))
      lastResults.value = outcome.results
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : '传输失败'
    } finally {
      busy.value = false
      await refresh()
    }
  }

  /* --------------------------- 档案室：对账裁定 / 正式档案 --------------------------- */

  async function decideConflict(treeId: string, choice: ResolveChoice, merged: PatrolPayload | null): Promise<void> {
    await resolveConflict(archiveRepo, treeId, choice, merged ? { origin: ARCHIVE_ORIGIN, data: merged } : null, nowIso())
    await refresh()
  }

  async function saveOfficial(treeId: string, payload: OfficialPayload): Promise<void> {
    await upsertOfficial(archiveRepo, treeId, ARCHIVE_ORIGIN, payload, nowIso())
    await refresh()
  }

  async function setReview(treeId: string, mark: string, marker: string): Promise<void> {
    const review: ReviewMark = { mark, marker, markedAt: nowIso() }
    await markReview(archiveRepo, treeId, ARCHIVE_ORIGIN, review)
    await refresh()
  }

  async function withdraw(treeId: string, reason: string): Promise<void> {
    await withdrawTree(archiveRepo, treeId, ARCHIVE_ORIGIN, reason, nowIso())
    await refresh()
  }

  async function reinstate(treeId: string): Promise<void> {
    await reinstateTree(archiveRepo, treeId, ARCHIVE_ORIGIN, nowIso())
    await refresh()
  }

  /* --------------------------- 老巡查单升级 --------------------------- */

  async function upgradeLegacy(): Promise<LegacyUpgradeResult> {
    const result = await upgradeLegacySheets(archiveRepo, legacySheets.value, registrarOrigin.value, nowIso())
    lastUpgrade.value = result
    await refresh()
    return result
  }

  /** 为陌生登记人补「登记人 -> 来历」映射，然后可再次升级 */
  async function mapUnknownRegistrar(registrar: string, origin: OriginId): Promise<void> {
    registrarOrigin.value = { ...registrarOrigin.value, [registrar]: origin }
  }

  return {
    // state
    trees,
    sessions,
    audits,
    legacySheets,
    tabletDrafts,
    sentPackages,
    currentOrigin,
    online,
    ready,
    busy,
    lastResults,
    lastUpgrade,
    lastError,
    // getters
    conflicts,
    tombstones,
    legacyTrees,
    // actions
    init,
    reseed,
    refresh,
    switchOrigin,
    setOnline,
    saveTabletDraft,
    sealCurrentPackage,
    sendPackageToArchive,
    decideConflict,
    saveOfficial,
    setReview,
    withdraw,
    reinstate,
    upgradeLegacy,
    mapUnknownRegistrar,
    RESOLVE_CHOICE,
  }
})
