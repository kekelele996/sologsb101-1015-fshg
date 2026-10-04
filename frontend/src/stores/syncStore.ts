/**
 * 离线对账状态管理（Pinia）
 *
 * 两头各自管各自那半：
 * - 平板端：离线记巡查单（平板库），回办公室交巡查包（整包传到档案室库）；
 * - 档案室端：按两边各自来历对账，认各自最新版，两边都改过的留两版等人定，
 *   撤掉的树留标记，旧单只归档不对账。
 *
 * 传一半失败后按那头重试，已认下那头不受影响，网络恢复后接着传（断点续传）。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Survey, SurveyDraft } from '../types/survey'
import type { ReconcileResult, SyncConflict, SyncPackage, SyncTombstone } from '../types/sync'
import { db, addTombstone, archiveReviewSurvey } from '../utils/db'
import { initTabletDatabase, listPatrolForms, putPatrolForm, removePatrolForm, tabletDb } from '../utils/sync/tabletDb'
import { reconcileForm, surveySnapshot } from '../utils/sync/engine'
import { nowIso, uuid } from '../utils/id'
import { useTreeStore } from './treeStore'

/** 平板登记人候选（旧单按登记人补一方） */
export const TABLET_REGISTRARS = ['张磊', '王芳', '李强']
/** 档案室登记人候选 */
export const ARCHIVE_REGISTRARS = ['陈静', '刘伟']

export const useSyncStore = defineStore('sync', () => {
  /* ------------------------------ 状态 ------------------------------ */
  const patrolForms = ref<Survey[]>([])
  const packages = ref<SyncPackage[]>([])
  const transferredForms = ref<Survey[]>([])
  const conflicts = ref<SyncConflict[]>([])
  const tombstones = ref<SyncTombstone[]>([])
  const archiveSurveys = ref<Survey[]>([])

  const loading = ref(false)
  const lastMessage = ref('')

  /** 模拟断网：传到第 failAfter 条失败 */
  const simulateNetworkFailure = ref(false)
  const failAfter = ref(2)

  /* ------------------------------ 派生 ------------------------------ */
  const pendingForms = computed<Survey[]>(() => patrolForms.value.filter((f) => f.syncState === 'pending'))
  const pendingConflictCount = computed<number>(() => conflicts.value.filter((c) => c.status === 'pending').length)
  const tombstonedTreeIds = computed<Set<string>>(() => new Set(tombstones.value.map((t) => t.treeId)))

  /** 古树编号 → 标签 */
  const treeLabel = computed<Record<string, string>>(() => {
    const treeStore = useTreeStore()
    return Object.fromEntries(treeStore.trees.map((t) => [t.id, `${t.code} ${t.species}`]))
  })

  /* ------------------------------ 订阅 ------------------------------ */
  let subscribed = false

  async function init(): Promise<void> {
    await initTabletDatabase()
    if (subscribed) return
    subscribed = true
    // 订阅平板巡查单
    liveQuery(() => tabletDb.patrolForms.toArray()).subscribe({
      next: (rows) => {
        patrolForms.value = rows.sort((a, b) => b.date.localeCompare(a.date))
      },
      error: () => undefined,
    })
    // 订阅档案室对账数据
    liveQuery(async () => {
      const [pkgRows, formRows, conflictRows, tombRows, surveyRows] = await Promise.all([
        db.syncPackages.toArray(),
        db.transferredForms.toArray(),
        db.syncConflicts.toArray(),
        db.syncTombstones.toArray(),
        db.surveys.toArray(),
      ])
      return { pkgRows, formRows, conflictRows, tombRows, surveyRows }
    }).subscribe({
      next: ({ pkgRows, formRows, conflictRows, tombRows, surveyRows }) => {
        packages.value = pkgRows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        transferredForms.value = formRows.sort((a, b) => b.date.localeCompare(a.date))
        conflicts.value = conflictRows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        tombstones.value = tombRows
        archiveSurveys.value = surveyRows
      },
      error: () => undefined,
    })
  }

  /* ------------------------------ 平板端：离线记巡查单 ------------------------------ */

  /** 新建平板巡查单（离线） */
  async function createPatrolForm(draft: SurveyDraft): Promise<Survey> {
    const stamp = nowIso()
    const row: Survey = {
      id: uuid('survey'),
      treeId: draft.treeId,
      date: draft.date,
      heightM: draft.heightM,
      dbhCm: draft.dbhCm,
      crownM: draft.crownM,
      leanDeg: draft.leanDeg,
      hollowCount: draft.hollowCount,
      siteNote: draft.siteNote,
      origin: 'tablet',
      registrar: draft.registrar.trim() || '张磊',
      version: 1,
      tombstone: false,
      syncState: 'pending',
      lastSyncedVersion: 0,
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    }
    await putPatrolForm(row)
    lastMessage.value = '巡查单已离线登记（平板本地），回办公室后交包。'
    return row
  }

  /** 编辑平板巡查单（离线，版本 +1） */
  async function updatePatrolForm(id: string, draft: SurveyDraft): Promise<void> {
    const existing = await tabletDb.patrolForms.get(id)
    if (!existing) return
    await putPatrolForm({
      ...existing,
      treeId: draft.treeId,
      date: draft.date,
      heightM: draft.heightM,
      dbhCm: draft.dbhCm,
      crownM: draft.crownM,
      leanDeg: draft.leanDeg,
      hollowCount: draft.hollowCount,
      siteNote: draft.siteNote,
      registrar: draft.registrar.trim() || existing.registrar,
      version: existing.version + 1,
      syncState: 'pending', // 改过之后重新待交包
      updatedAt: nowIso(),
    })
    lastMessage.value = '巡查单已更新（平板本地），版本 +1，待交包。'
  }

  /** 删除平板巡查单 */
  async function deletePatrolForm(id: string): Promise<void> {
    await removePatrolForm(id)
  }

  /* ------------------------------ 交包：平板 → 档案室（整包传输，断点续传） ------------------------------ */

  /**
   * 交巡查包：把平板待交包的巡查单整包传到档案室库。
   * 传一半失败后按那头重试，已认下那头不受影响，网络恢复后接着传。
   */
  async function handInPackage(): Promise<string | null> {
    const forms = await listPatrolForms()
    const pending = forms.filter((f) => f.syncState === 'pending')
    if (pending.length === 0) {
      lastMessage.value = '没有待交包的巡查单。'
      return null
    }

    const packageId = uuid('pkg')
    const pkg: SyncPackage = {
      id: packageId,
      createdAt: nowIso(),
      status: 'transferring',
      totalItems: pending.length,
      ackedItems: 0,
      failAt: simulateNetworkFailure.value ? Math.min(failAfter.value, pending.length) : 0,
      items: {},
      lastError: '',
    }
    pending.forEach((f) => {
      pkg.items[f.id] = 'pending'
    })
    await db.syncPackages.put(pkg)

    await transferPackage(packageId)
    return packageId
  }

  /** 续传：从上次失败的包接着传 */
  async function resumePackage(packageId: string): Promise<void> {
    await transferPackage(packageId)
  }

  /** 传输一个包（从 ackedItems 处继续，断点续传） */
  async function transferPackage(packageId: string): Promise<void> {
    const pkg = await db.syncPackages.get(packageId)
    if (!pkg) return
    if (pkg.status === 'completed') return

    loading.value = true
    try {
      const forms = await listPatrolForms()
      const pending = forms.filter((f) => pkg.items[f.id] !== undefined)
      // 按包内顺序传输
      const ordered = pending.sort((a, b) => {
        const ai = Object.keys(pkg.items).indexOf(a.id)
        const bi = Object.keys(pkg.items).indexOf(b.id)
        return ai - bi
      })

      for (let i = pkg.ackedItems; i < ordered.length; i++) {
        const form = ordered[i]
        // 模拟断网：传到第 failAt 条失败
        if (pkg.failAt > 0 && i >= pkg.failAt) {
          await db.syncPackages.update(packageId, {
            status: 'partial',
            ackedItems: i,
            lastError: `模拟断网：传到第 ${i + 1} 条时连接中断，已传 ${i} 条。`,
          })
          lastMessage.value = `传一半断网了：已传 ${i} 条，剩余 ${ordered.length - i} 条待续传。已认下的那头不受影响。`
          return
        }
        // 逐条传到档案室库（复制到 transferredForms）
        await db.transferredForms.put({ ...form, syncState: 'transferring' })
        pkg.items[form.id] = 'transferred'
        await db.syncPackages.update(packageId, { ackedItems: i + 1, items: { ...pkg.items } })
        // 标记平板端已交包
        await putPatrolForm({ ...form, syncState: 'transferring' })
      }

      await db.syncPackages.update(packageId, { status: 'completed', lastError: '' })
      lastMessage.value = `巡查包已传完：共 ${ordered.length} 条，档案室可对账。`
    } finally {
      loading.value = false
    }
  }

  /* ------------------------------ 档案室：对账 ------------------------------ */

  /**
   * 对一个包的巡查单逐条对账。
   * 同一条认各自最新版，两边都改过的留两版等人定，撞墓碑的不能带回来，旧单只归档不对账。
   */
  async function reconcilePackage(packageId: string): Promise<ReconcileResult[]> {
    const pkg = await db.syncPackages.get(packageId)
    if (!pkg || pkg.status !== 'completed') {
      lastMessage.value = '巡查包未传完，不能对账。'
      return []
    }

    const forms = await db.transferredForms.where('id').anyOf(Object.keys(pkg.items)).toArray()
    const results: ReconcileResult[] = []

    for (const form of forms) {
      const archiveSurvey = await db.surveys.get(form.id)
      const tombstone = await db.syncTombstones.get(form.treeId)
      const result = reconcileForm(form, archiveSurvey, tombstone)
      results.push(result)

      switch (result.status) {
        case 'accepted':
          // 认下平板版：写入档案室正式档案，lastSyncedVersion 对齐
          await db.surveys.put({
            ...form,
            origin: 'tablet',
            syncState: 'synced',
            lastSyncedVersion: form.version,
            updatedAt: nowIso(),
            revision: 3,
          })
          await db.transferredForms.update(form.id, { syncState: 'synced' })
          break
        case 'conflict':
          // 两边都改过：留两版等人定
          await db.syncConflicts.put({
            id: uuid('conflict'),
            treeId: form.treeId,
            formId: form.id,
            tabletVersion: surveySnapshot(form),
            archiveVersion: surveySnapshot(archiveSurvey!),
            createdAt: nowIso(),
            status: 'pending',
          })
          await db.transferredForms.update(form.id, { syncState: 'conflict' })
          break
        case 'rejected-tombstone':
          // 撞墓碑：不能带回来
          await db.transferredForms.update(form.id, { syncState: 'rejected' })
          break
        case 'archived-legacy':
          // 旧单只归档不对账
          await db.transferredForms.update(form.id, { syncState: 'archived-legacy' })
          break
        case 'superseded':
          // 档案室版更新：平板旧版被顶掉，档案室版不动
          await db.transferredForms.update(form.id, { syncState: 'synced' })
          break
      }
    }

    const accepted = results.filter((r) => r.status === 'accepted').length
    const conflict = results.filter((r) => r.status === 'conflict').length
    const rejected = results.filter((r) => r.status === 'rejected-tombstone').length
    const legacy = results.filter((r) => r.status === 'archived-legacy').length
    lastMessage.value = `对账完成：认下 ${accepted} 条，冲突 ${conflict} 条，撞墓碑 ${rejected} 条，旧单归档 ${legacy} 条。`
    return results
  }

  /* ------------------------------ 档案室：冲突裁定 ------------------------------ */

  /** 裁定冲突：认下平板版 */
  async function resolveConflictTablet(conflictId: string): Promise<void> {
    const conflict = await db.syncConflicts.get(conflictId)
    if (!conflict) return
    const tablet = conflict.tabletVersion as unknown as Survey
    await db.surveys.put({
      ...tablet,
      origin: 'tablet',
      syncState: 'synced',
      lastSyncedVersion: tablet.version,
      updatedAt: nowIso(),
      revision: 3,
    })
    await db.syncConflicts.update(conflictId, { status: 'resolved-tablet' })
    lastMessage.value = '已裁定：认下平板版。'
  }

  /** 裁定冲突：认下档案室版 */
  async function resolveConflictArchive(conflictId: string): Promise<void> {
    const conflict = await db.syncConflicts.get(conflictId)
    if (!conflict) return
    const archive = conflict.archiveVersion as unknown as Survey
    await db.surveys.put({
      ...archive,
      origin: 'archive',
      syncState: 'synced',
      lastSyncedVersion: archive.version,
      updatedAt: nowIso(),
      revision: 3,
    })
    await db.syncConflicts.update(conflictId, { status: 'resolved-archive' })
    lastMessage.value = '已裁定：认下档案室版。'
  }

  /* ------------------------------ 档案室：撤掉古树（留墓碑） ------------------------------ */

  /** 撤掉古树：写墓碑标记，不物理删除 */
  async function withdrawTree(treeId: string, reason: string): Promise<void> {
    await addTombstone(treeId, reason)
    lastMessage.value = `古树已撤掉并留标记：${reason}。巡查包里再冒出同一株不能带回来。`
  }

  /** 档案室复核修正巡查单（版本 +1，标记档案室来历） */
  async function reviewSurvey(row: Survey): Promise<void> {
    await archiveReviewSurvey(row)
    lastMessage.value = '复核结论已更新（档案室版），版本 +1。'
  }

  return {
    // 状态
    patrolForms,
    packages,
    transferredForms,
    conflicts,
    tombstones,
    archiveSurveys,
    loading,
    lastMessage,
    simulateNetworkFailure,
    failAfter,
    // 派生
    pendingForms,
    pendingConflictCount,
    tombstonedTreeIds,
    treeLabel,
    // 平板
    init,
    createPatrolForm,
    updatePatrolForm,
    deletePatrolForm,
    // 交包
    handInPackage,
    resumePackage,
    // 对账
    reconcilePackage,
    // 冲突裁定
    resolveConflictTablet,
    resolveConflictArchive,
    // 档案室
    withdrawTree,
    reviewSurvey,
  }
})
