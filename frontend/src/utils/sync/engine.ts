/**
 * 对账引擎（纯函数）
 *
 * 档案室按两边各自来历对账，核心规则：
 * 1. 同一条认各自最新版（LWW per side）——版本号大的那版留下；
 * 2. 两边都改过的树先留两版等人定（conflict）——平板和档案室都改过同一条，
 *    且都比「上次认下的版本」新，就把两版都留下，等人工裁定；
 * 3. 撤掉的树要留标记（tombstone）——巡查包里再冒出同一株不能带回来；
 * 4. 旧巡查单没来历（legacy）——只归档不对账，不参与版本比拼。
 *
 * 全部是纯函数，不碰数据库，便于单测与复用。
 */
import type { Survey } from '../../types/survey'
import type { ReconcileResult, SyncTombstone } from '../../types/sync'

/**
 * 对一条平板交来的巡查单做对账判定。
 *
 * @param form 平板交来的巡查单（transferredForm）
 * @param archiveSurvey 档案室现有的同一条巡查单（可能不存在）
 * @param tombstone 该古树的墓碑（可能不存在）
 * @returns 对账处置结果
 */
export function reconcileForm(
  form: Survey,
  archiveSurvey: Survey | undefined,
  tombstone: SyncTombstone | undefined,
): ReconcileResult {
  // 规则 3：撞墓碑——撤掉的树又冒出来，不能带回来
  if (tombstone !== undefined) {
    return {
      formId: form.id,
      treeId: form.treeId,
      status: 'rejected-tombstone',
      reason: `古树已撤掉（${tombstone.reason}），巡查包里再冒出同一株不能带回来。`,
    }
  }

  // 规则 4：旧单只归档不对账
  if (form.origin === 'legacy') {
    return {
      formId: form.id,
      treeId: form.treeId,
      status: 'archived-legacy',
      reason: '旧巡查单没来历，升级时按登记人补了一方，只归档不对账。',
    }
  }

  // 档案室没有同一条：新巡查单，直接认下
  if (archiveSurvey === undefined) {
    return {
      formId: form.id,
      treeId: form.treeId,
      status: 'accepted',
      reason: '档案室无同一条，平板巡查单为最新版，认下。',
    }
  }

  // 两边都没改过（版本号相同）：已同步，无需处置
  if (form.version === archiveSurvey.version) {
    return {
      formId: form.id,
      treeId: form.treeId,
      status: 'superseded',
      reason: '两边版本号相同，已同步。',
    }
  }

  // 规则 2：两边都改过——平板版比档案室新，且档案室版也比「上次认下的版本」新
  const bothModified =
    form.version > archiveSurvey.lastSyncedVersion && archiveSurvey.version > archiveSurvey.lastSyncedVersion

  if (bothModified) {
    return {
      formId: form.id,
      treeId: form.treeId,
      status: 'conflict',
      reason: `两边都改过（平板 v${form.version} / 档案室 v${archiveSurvey.version}，上次认下 v${archiveSurvey.lastSyncedVersion}），先留两版等人定。`,
    }
  }

  // 规则 1：同一条认各自最新版——版本号大的留下
  if (form.version > archiveSurvey.version) {
    return {
      formId: form.id,
      treeId: form.treeId,
      status: 'accepted',
      reason: `平板版 v${form.version} 比档案室版 v${archiveSurvey.version} 新，认下平板版。`,
    }
  }

  // 档案室版更新：平板这版是旧的，被顶掉
  return {
    formId: form.id,
    treeId: form.treeId,
    status: 'superseded',
    reason: `档案室版 v${archiveSurvey.version} 比平板版 v${form.version} 新，平板旧版被顶掉。`,
  }
}

/**
 * 批量对账：对一包巡查单逐条判定。
 */
export function reconcilePackage(
  forms: Survey[],
  archiveSurveys: Map<string, Survey>,
  tombstones: Map<string, SyncTombstone>,
): ReconcileResult[] {
  return forms.map((form) => reconcileForm(form, archiveSurveys.get(form.id), tombstones.get(form.treeId)))
}

/**
 * 从巡查单快照中提取可比较的字段（用于冲突两版展示）。
 */
export function surveySnapshot(row: Survey): Record<string, unknown> {
  return {
    id: row.id,
    treeId: row.treeId,
    date: row.date,
    heightM: row.heightM,
    dbhCm: row.dbhCm,
    crownM: row.crownM,
    leanDeg: row.leanDeg,
    hollowCount: row.hollowCount,
    siteNote: row.siteNote,
    origin: row.origin,
    registrar: row.registrar,
    version: row.version,
    updatedAt: row.updatedAt,
  }
}
