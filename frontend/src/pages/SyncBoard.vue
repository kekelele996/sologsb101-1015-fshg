<script setup lang="ts">
/**
 * /sync 巡查对账
 * 两头各自管各自那半：平板离线记巡查单，回办公室交巡查包；
 * 档案室按两边各自来历对账，认各自最新版，两边都改过的留两版等人定，
 * 撤掉的树留标记，旧单只归档不对账。传一半失败后断点续传。
 * 消费模型：Survey、SyncPackage、SyncConflict、SyncTombstone；复用组件：<StatBadge>、<EmptyPanel>
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useSyncStore, ARCHIVE_REGISTRARS, TABLET_REGISTRARS } from '@/stores/syncStore'
import { useTreeStore } from '@/stores/treeStore'
import type { Survey, SurveyDraft } from '@/types/survey'
import { SITE_NOTE_OPTIONS, type SiteNote } from '@/types/survey'
import type { SyncPackage } from '@/types/sync'

const syncStore = useSyncStore()
const treeStore = useTreeStore()

const activeTab = ref<'tablet' | 'archive'>('tablet')

/* ------------------------------ 平板端表单 ------------------------------ */
const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()

const form = reactive<SurveyDraft>({
  treeId: '',
  date: '',
  heightM: 12,
  dbhCm: 60,
  crownM: 8,
  leanDeg: 2,
  hollowCount: 0,
  siteNote: '裸土',
  registrar: '张磊',
})

const rules: FormRules<SurveyDraft> = {
  treeId: [{ required: true, message: '请选择古树', trigger: 'change' }],
  date: [{ required: true, message: '请选择检查日期', trigger: 'change' }],
  registrar: [{ required: true, message: '请填写登记人', trigger: 'change' }],
}

const tabletForms = computed<Survey[]>(() => syncStore.patrolForms)
const pendingCount = computed<number>(() => syncStore.pendingForms.length)

/* ------------------------------ 档案室端 ------------------------------ */
const packages = computed<SyncPackage[]>(() => syncStore.packages)
const conflicts = computed(() => syncStore.conflicts.filter((c) => c.status === 'pending'))
const tombstones = computed(() => syncStore.tombstones)
const legacyForms = computed(() => {
  // 旧单在档案室 surveys 表里（v3 迁移时标记为 archived-legacy），
  // 以及新交包里 origin=legacy 只归档不对账的条目
  const fromSurveys = syncStore.archiveSurveys.filter((f) => f.syncState === 'archived-legacy')
  const fromTransferred = syncStore.transferredForms.filter((f) => f.syncState === 'archived-legacy')
  return [...fromSurveys, ...fromTransferred]
})
const rejectedForms = computed(() =>
  syncStore.transferredForms.filter((f) => f.syncState === 'rejected'),
)

onMounted(() => {
  void treeStore.loadAll()
  void syncStore.init()
})

/* ------------------------------ 平板端操作 ------------------------------ */
function openCreate(): void {
  editingId.value = null
  Object.assign(form, {
    treeId: treeStore.currentTreeId ?? treeStore.trees[0]?.id ?? '',
    date: new Date().toISOString().slice(0, 10),
    heightM: 12,
    dbhCm: 60,
    crownM: 8,
    leanDeg: 2,
    hollowCount: 0,
    siteNote: '裸土' as SiteNote,
    registrar: TABLET_REGISTRARS[0],
  })
  dialogVisible.value = true
}

function openEdit(row: Survey): void {
  editingId.value = row.id
  Object.assign(form, {
    treeId: row.treeId,
    date: row.date,
    heightM: row.heightM,
    dbhCm: row.dbhCm,
    crownM: row.crownM,
    leanDeg: row.leanDeg,
    hollowCount: row.hollowCount,
    siteNote: row.siteNote,
    registrar: row.registrar,
  })
  dialogVisible.value = true
}

async function handleSubmit(): Promise<void> {
  if (formRef.value === undefined) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    if (editingId.value === null) {
      await syncStore.createPatrolForm({ ...form })
      ElMessage.success('巡查单已离线登记（平板本地）')
    } else {
      await syncStore.updatePatrolForm(editingId.value, { ...form })
      ElMessage.success('巡查单已更新（平板本地）')
    }
    dialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  } finally {
    submitting.value = false
  }
}

async function handleDelete(row: Survey): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除平板本地 ${row.date} 的巡查单？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await syncStore.deletePatrolForm(row.id)
  ElMessage.success('巡查单已删除')
}

async function handleHandIn(): Promise<void> {
  if (pendingCount.value === 0) {
    ElMessage.info('没有待交包的巡查单')
    return
  }
  const id = await syncStore.handInPackage()
  if (id !== null) {
    ElMessage.success(syncStore.lastMessage)
  }
}

async function handleResume(pkg: SyncPackage): Promise<void> {
  await syncStore.resumePackage(pkg.id)
  ElMessage.success(syncStore.lastMessage)
}

/* ------------------------------ 档案室端操作 ------------------------------ */
async function handleReconcile(pkg: SyncPackage): Promise<void> {
  const results = await syncStore.reconcilePackage(pkg.id)
  if (results.length === 0) {
    ElMessage.info(syncStore.lastMessage)
    return
  }
  ElMessage.success(syncStore.lastMessage)
}

async function handleResolveTablet(conflictId: string): Promise<void> {
  await syncStore.resolveConflictTablet(conflictId)
  ElMessage.success('已裁定：认下平板版')
}

async function handleResolveArchive(conflictId: string): Promise<void> {
  await syncStore.resolveConflictArchive(conflictId)
  ElMessage.success('已裁定：认下档案室版')
}

async function handleWithdraw(treeId: string): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `撤掉该古树并留标记？撤掉后巡查包里再冒出同一株不能带回来。`,
      '撤掉古树',
      { type: 'warning', confirmButtonText: '撤掉并留标记', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  await syncStore.withdrawTree(treeId, '人工撤档')
  ElMessage.success('古树已撤掉并留标记')
}

async function handleReview(row: Survey): Promise<void> {
  // 档案室复核修正：版本 +1，标记档案室来历（可能与平板修改冲突）
  await syncStore.reviewSurvey(row)
  ElMessage.success('复核结论已更新（档案室版），版本 +1')
}

function originTagType(origin: string): 'primary' | 'success' | 'info' {
  if (origin === 'tablet') return 'primary'
  if (origin === 'archive') return 'success'
  return 'info'
}

function stateTagType(state: string): 'warning' | 'success' | 'danger' | 'info' {
  if (state === 'pending' || state === 'transferring') return 'warning'
  if (state === 'synced') return 'success'
  if (state === 'conflict' || state === 'rejected') return 'danger'
  return 'info'
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="平板待交包" :value="pendingCount" suffix="条" tone="warning" icon="Files" />
      <StatBadge label="巡查包" :value="packages.length" suffix="个" tone="primary" icon="Box" />
      <StatBadge label="待裁冲突" :value="conflicts.length" suffix="条" tone="danger" icon="Warning" />
      <StatBadge label="墓碑标记" :value="tombstones.length" suffix="株" tone="info" icon="Hide" />
      <StatBadge label="旧单归档" :value="legacyForms.length" suffix="条" tone="success" icon="Archive" />
    </div>

    <el-alert
      type="info"
      show-icon
      :closable="false"
      class="mb-14"
      title="两头各自管各自那半：平板离线记巡查单，回办公室交巡查包；档案室按两边各自来历对账，认各自最新版，两边都改过的留两版等人定。"
    />

    <el-tabs v-model="activeTab">
      <!-- ==================== 平板端 ==================== -->
      <el-tab-pane label="平板离线（巡查班）" name="tablet">
        <el-card shadow="never">
          <template #header>
            <div class="card-header">
              <span class="card-header__title">平板离线巡查单</span>
              <el-space wrap>
                <el-checkbox v-model="syncStore.simulateNetworkFailure" border size="small">
                  模拟断网（传到第
                  <el-input-number
                    v-model="syncStore.failAfter"
                    :min="1"
                    :max="20"
                    size="small"
                    style="width: 70px; margin: 0 4px"
                  />
                  条失败）
                </el-checkbox>
                <el-button type="primary" @click="openCreate" :disabled="treeStore.trees.length === 0">
                  <el-icon><Plus /></el-icon>
                  <span>新增巡查单</span>
                </el-button>
                <el-button type="success" @click="handleHandIn" :disabled="pendingCount === 0">
                  <el-icon><Upload /></el-icon>
                  <span>交巡查包（{{ pendingCount }}）</span>
                </el-button>
              </el-space>
            </div>
          </template>

          <EmptyPanel
            v-if="tabletForms.length === 0 && !syncStore.loading"
            title="平板本地还没有巡查单"
            description="山上没信号时在平板上离线登记巡查单，回办公室后整包交到档案室对账。"
            action-text="新增第一条巡查单"
            @action="openCreate"
          />

          <el-table v-else :data="tabletForms" row-key="id" stripe v-loading="syncStore.loading">
            <el-table-column label="古树" min-width="180">
              <template #default="{ row }">
                <div class="cell-stack">
                  <span>{{ syncStore.treeLabel[row.treeId] ?? '（古树已删除）' }}</span>
                  <span class="cell-sub">{{ row.date }} · 登记人 {{ row.registrar }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="树高(m)" width="100">
              <template #default="{ row }">{{ row.heightM }}</template>
            </el-table-column>
            <el-table-column label="胸径(cm)" width="110">
              <template #default="{ row }">{{ row.dbhCm }}</template>
            </el-table-column>
            <el-table-column label="立地" width="90">
              <template #default="{ row }">
                <el-tag size="small" type="info">{{ row.siteNote }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="版本" width="80">
              <template #default="{ row }">
                <el-tag size="small" :type="originTagType(row.origin)">v{{ row.version }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="110">
              <template #default="{ row }">
                <el-tag size="small" :type="stateTagType(row.syncState)">{{ row.syncState }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="150" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" size="small" @click.stop="openEdit(row)">编辑</el-button>
                <el-button link type="danger" size="small" @click.stop="handleDelete(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- ==================== 档案室端 ==================== -->
      <el-tab-pane label="档案室对账" name="archive">
        <el-row :gutter="14">
          <el-col :xs="24" :lg="14">
            <!-- 巡查包 -->
            <el-card shadow="never" class="mb-14">
              <template #header>
                <div class="card-header">
                  <span class="card-header__title">巡查包（交包记录）</span>
                  <el-tag type="info" effect="plain">传一半失败后断点续传，已认下那头不受影响</el-tag>
                </div>
              </template>
              <EmptyPanel
                v-if="packages.length === 0"
                title="还没有巡查包"
                description="平板回办公室交巡查包后，这里会显示包的传输状态，传完即可对账。"
              />
              <el-table v-else :data="packages" row-key="id" stripe>
                <el-table-column label="交包时间" width="170">
                  <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString('zh-CN') }}</template>
                </el-table-column>
                <el-table-column label="条目" width="80">
                  <template #default="{ row }">{{ row.totalItems }}</template>
                </el-table-column>
                <el-table-column label="已传" width="80">
                  <template #default="{ row }">{{ row.ackedItems }}</template>
                </el-table-column>
                <el-table-column label="状态" width="100">
                  <template #default="{ row }">
                    <el-tag size="small" :type="row.status === 'completed' ? 'success' : row.status === 'partial' ? 'warning' : 'info'">
                      {{ row.status }}
                    </el-tag>
                  </template>
                </el-table-column>
                <el-table-column label="操作" width="200" fixed="right">
                  <template #default="{ row }">
                    <el-button
                      v-if="row.status === 'partial'"
                      link
                      type="warning"
                      size="small"
                      @click="handleResume(row)"
                    >
                      续传
                    </el-button>
                    <el-button
                      link
                      type="primary"
                      size="small"
                      :disabled="row.status !== 'completed'"
                      @click="handleReconcile(row)"
                    >
                      对账
                    </el-button>
                  </template>
                </el-table-column>
              </el-table>
            </el-card>

            <!-- 冲突：两边都改过，留两版等人定 -->
            <el-card shadow="never" class="mb-14">
              <template #header>
                <div class="card-header">
                  <span class="card-header__title">对账冲突（两版等人定）</span>
                  <el-tag type="danger" effect="plain">两边都改过的树先留两版等人定</el-tag>
                </div>
              </template>
              <EmptyPanel
                v-if="conflicts.length === 0"
                title="没有待裁冲突"
                description="平板和档案室都改过同一条巡查单时，会把两版都留在这里等人工裁定。"
              />
              <div v-else class="conflict-list">
                <div v-for="c in conflicts" :key="c.id" class="conflict-item">
                  <div class="conflict-item__head">
                    <el-tag type="danger" size="small">冲突</el-tag>
                    <span class="conflict-item__tree">{{ syncStore.treeLabel[c.treeId] ?? c.treeId }}</span>
                    <span class="cell-sub">{{ new Date(c.createdAt).toLocaleString('zh-CN') }}</span>
                  </div>
                  <el-row :gutter="12" class="conflict-item__versions">
                    <el-col :span="12">
                      <div class="version-card version-card--tablet">
                        <div class="version-card__label">平板版</div>
                        <div class="version-card__value">
                          树高 {{ (c.tabletVersion as any).heightM }}m / 胸径 {{ (c.tabletVersion as any).dbhCm }}cm /
                          立地 {{ (c.tabletVersion as any).siteNote }}
                        </div>
                        <div class="cell-sub">登记人 {{ (c.tabletVersion as any).registrar }} · v{{ (c.tabletVersion as any).version }}</div>
                      </div>
                    </el-col>
                    <el-col :span="12">
                      <div class="version-card version-card--archive">
                        <div class="version-card__label">档案室版</div>
                        <div class="version-card__value">
                          树高 {{ (c.archiveVersion as any).heightM }}m / 胸径 {{ (c.archiveVersion as any).dbhCm }}cm /
                          立地 {{ (c.archiveVersion as any).siteNote }}
                        </div>
                        <div class="cell-sub">登记人 {{ (c.archiveVersion as any).registrar }} · v{{ (c.archiveVersion as any).version }}</div>
                      </div>
                    </el-col>
                  </el-row>
                  <el-space class="conflict-item__actions">
                    <el-button size="small" type="primary" @click="handleResolveTablet(c.id)">认下平板版</el-button>
                    <el-button size="small" type="success" @click="handleResolveArchive(c.id)">认下档案室版</el-button>
                  </el-space>
                </div>
              </div>
            </el-card>
          </el-col>

          <el-col :xs="24" :lg="10">
            <!-- 墓碑：撤掉的树要留标记 -->
            <el-card shadow="never" class="mb-14">
              <template #header>
                <div class="card-header">
                  <span class="card-header__title">墓碑标记（撤掉的树）</span>
                  <el-space wrap>
                    <el-tag type="info" effect="plain">撤掉的树要留标记</el-tag>
                    <el-button size="small" type="danger" plain @click="handleWithdraw(treeStore.currentTreeId ?? treeStore.trees[0]?.id ?? '')">
                      撤掉当前古树
                    </el-button>
                  </el-space>
                </div>
              </template>
              <EmptyPanel
                v-if="tombstones.length === 0"
                title="没有墓碑标记"
                description="撤掉的古树会留标记，巡查包里再冒出同一株不能带回来。可在古树档案页撤掉古树。"
              />
              <div v-else class="tombstone-list">
                <div v-for="t in tombstones" :key="t.treeId" class="tombstone-item">
                  <el-tag type="info" size="small">墓碑</el-tag>
                  <span>{{ syncStore.treeLabel[t.treeId] ?? t.treeId }}</span>
                  <span class="cell-sub">{{ t.reason }} · {{ new Date(t.removedAt).toLocaleString('zh-CN') }}</span>
                </div>
              </div>
            </el-card>

            <!-- 撞墓碑被拒的 -->
            <el-card shadow="never" class="mb-14">
              <template #header>
                <div class="card-header">
                  <span class="card-header__title">撞墓碑被拒</span>
                  <el-tag type="danger" effect="plain">巡查包里再冒出同一株不能带回来</el-tag>
                </div>
              </template>
              <EmptyPanel
                v-if="rejectedForms.length === 0"
                title="没有被拒的巡查单"
                description="撞墓碑的巡查单会在这里显示，不能带回来认下。"
              />
              <el-table v-else :data="rejectedForms" row-key="id" size="small">
                <el-table-column label="古树" min-width="160">
                  <template #default="{ row }">{{ syncStore.treeLabel[row.treeId] ?? row.treeId }}</template>
                </el-table-column>
                <el-table-column label="日期" width="110">
                  <template #default="{ row }">{{ row.date }}</template>
                </el-table-column>
              </el-table>
            </el-card>

            <!-- 旧单只归档不对账 -->
            <el-card shadow="never">
              <template #header>
                <div class="card-header">
                  <span class="card-header__title">旧单归档（只归档不对账）</span>
                  <el-tag type="success" effect="plain">旧巡查单没来历，按登记人补一方</el-tag>
                </div>
              </template>
              <EmptyPanel
                v-if="legacyForms.length === 0"
                title="没有旧单"
                description="升级前的旧巡查单会按登记人补一方并只归档不对账。"
              />
              <el-table v-else :data="legacyForms" row-key="id" size="small">
                <el-table-column label="古树" min-width="160">
                  <template #default="{ row }">{{ syncStore.treeLabel[row.treeId] ?? row.treeId }}</template>
                </el-table-column>
                <el-table-column label="登记人" width="90">
                  <template #default="{ row }">{{ row.registrar || '未知' }}</template>
                </el-table-column>
                <el-table-column label="来历" width="80">
                  <template #default="{ row }">
                    <el-tag size="small" :type="originTagType(row.origin)">{{ row.origin }}</el-tag>
                  </template>
                </el-table-column>
              </el-table>
            </el-card>
          </el-col>
        </el-row>

        <!-- 档案室巡查单：复核修正（可能与平板修改冲突） -->
        <el-card shadow="never" class="mb-14">
          <template #header>
            <div class="card-header">
              <span class="card-header__title">档案室巡查单（复核修正）</span>
              <el-tag type="success" effect="plain">档案室管正式档案与复核标记</el-tag>
            </div>
          </template>
          <el-table :data="syncStore.archiveSurveys" row-key="id" stripe size="small">
            <el-table-column label="古树" min-width="180">
              <template #default="{ row }">{{ syncStore.treeLabel[row.treeId] ?? '（古树已删除）' }}</template>
            </el-table-column>
            <el-table-column label="日期" width="110">
              <template #default="{ row }">{{ row.date }}</template>
            </el-table-column>
            <el-table-column label="树高(m)" width="90">
              <template #default="{ row }">{{ row.heightM }}</template>
            </el-table-column>
            <el-table-column label="来历" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="originTagType(row.origin)">{{ row.origin }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="版本" width="80">
              <template #default="{ row }">v{{ row.version }}</template>
            </el-table-column>
            <el-table-column label="状态" width="110">
              <template #default="{ row }">
                <el-tag size="small" :type="stateTagType(row.syncState)">{{ row.syncState }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="130" fixed="right">
              <template #default="{ row }">
                <el-button link type="success" size="small" @click="handleReview(row)">复核修正</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>
    </el-tabs>

    <!-- 平板端新增 / 编辑巡查单 -->
    <el-dialog v-model="dialogVisible" :title="editingId === null ? '新增平板巡查单' : '编辑平板巡查单'" width="660px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
        <el-form-item label="古树" prop="treeId">
          <el-select v-model="form.treeId" filterable style="width: 100%">
            <el-option
              v-for="tree in treeStore.trees"
              :key="tree.id"
              :value="tree.id"
              :label="`${tree.code} · ${tree.species} · ${tree.location}`"
            />
          </el-select>
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="检查日期" prop="date">
              <el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="登记人" prop="registrar">
              <el-select v-model="form.registrar" filterable allow-create style="width: 100%">
                <el-option v-for="r in [...TABLET_REGISTRARS, ...ARCHIVE_REGISTRARS]" :key="r" :value="r" :label="r" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="树高（m）" prop="heightM">
              <el-input-number v-model="form.heightM" :min="0.1" :max="120" :step="0.1" :precision="2" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="胸径（cm）" prop="dbhCm">
              <el-input-number v-model="form.dbhCm" :min="1" :max="600" :step="0.5" :precision="2" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="冠幅（m）" prop="crownM">
              <el-input-number v-model="form.crownM" :min="0.1" :max="80" :step="0.1" :precision="2" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="倾斜度（°）" prop="leanDeg">
              <el-input-number v-model="form.leanDeg" :min="0" :max="90" :step="0.1" :precision="2" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="空洞数（处）" prop="hollowCount">
              <el-input-number v-model="form.hollowCount" :min="0" :max="99" :step="1" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="立地状况" prop="siteNote">
          <el-radio-group v-model="form.siteNote">
            <el-radio v-for="item in SITE_NOTE_OPTIONS" :key="item" :value="item">{{ item }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-alert
          type="info"
          show-icon
          :closable="false"
          title="平板离线登记：数据只存在平板本地，回办公室交巡查包后才传到档案室。"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">保存到平板</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.stat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 14px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.card-header__title {
  font-size: 15px;
  font-weight: 600;
  color: #2f2a24;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cell-sub {
  font-size: 12px;
  color: #8c8479;
}

.mb-14 {
  margin-bottom: 14px;
}

.conflict-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.conflict-item {
  border: 1px solid #f0d9d5;
  border-radius: 8px;
  padding: 12px;
  background: #fdf6f5;
}

.conflict-item__head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.conflict-item__tree {
  font-weight: 600;
  color: #2f2a24;
}

.conflict-item__versions {
  margin-bottom: 10px;
}

.version-card {
  border-radius: 6px;
  padding: 10px;
  font-size: 13px;
}

.version-card--tablet {
  background: #eef4fb;
  border: 1px solid #cfe0f5;
}

.version-card--archive {
  background: #f0f5ee;
  border: 1px solid #d4e0cf;
}

.version-card__label {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 4px;
  color: #6b6257;
}

.version-card__value {
  color: #2f2a24;
  margin-bottom: 4px;
}

.conflict-item__actions {
  display: flex;
  gap: 8px;
}

.tombstone-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tombstone-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: #f5f3ee;
  border-radius: 6px;
  font-size: 13px;
}
</style>
