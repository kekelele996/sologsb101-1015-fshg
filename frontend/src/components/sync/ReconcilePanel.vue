<template>
  <el-card shadow="never" class="panel">
    <template #header>
      <div class="panel__head">
        <span>🏛️ 档案室对账台（正式档案 + 复核标记，平板够不到）</span>
        <el-tag size="small" type="warning">{{ store.conflicts.length }} 株待人定</el-tag>
      </div>
    </template>

    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="认账只按各自来历比版本：同一来历认最新、旧版跳过；两个来历都改过的树先留两版，不自动覆盖。"
      class="panel__tip"
    />

    <!-- 待裁定冲突 -->
    <div v-if="store.conflicts.length > 0" class="panel__subhead">⚠️ 都改过的树 · 两版待人定</div>
    <div v-for="tree in store.conflicts" :key="`c-${tree.treeId}`" class="conflict">
      <div class="conflict__title">{{ tree.treeId }}</div>
      <div class="conflict__sides">
        <el-card shadow="hover" class="conflict__side">
          <template #header>来人版（{{ tree.conflict!.incoming.origin }} v{{ tree.conflict!.incoming.version }}）</template>
          <PatrolView :half="tree.conflict!.incoming" />
        </el-card>
        <el-card shadow="hover" class="conflict__side">
          <template #header>在档版（{{ tree.conflict!.local.origin }} v{{ tree.conflict!.local.version }}）</template>
          <PatrolView :half="tree.conflict!.local" />
        </el-card>
      </div>
      <el-input
        v-model="mergeNotes[tree.treeId]"
        size="small"
        placeholder="人工合并结论（留空点「人工合并」则沿用在档记录）"
        class="conflict__merge"
      />
      <div class="conflict__actions">
        <el-button size="small" type="primary" @click="decide(tree.treeId, 'incoming')">认来人版</el-button>
        <el-button size="small" @click="decide(tree.treeId, 'local')">认在档版</el-button>
        <el-button size="small" type="warning" @click="decide(tree.treeId, 'merge')">人工合并落档</el-button>
      </div>
    </div>

    <!-- 档案台账 -->
    <div class="panel__subhead">一树一台账（巡查半 / 正式档案半 / 复核 / 撤档 分列，互不覆盖）</div>
    <el-table :data="activeTrees" size="small" border empty-text="档案室暂无在档树">
      <el-table-column prop="treeId" label="树号" width="110" />
      <el-table-column label="巡查半（平板）" min-width="200">
        <template #default="{ row }">
          <template v-if="row.patrol">
            <div>{{ row.patrol.origin }} v{{ row.patrol.version }} · {{ row.patrol.data.vigor }}</div>
            <div class="muted">{{ row.patrol.data.note }}</div>
          </template>
          <span v-else class="muted">无</span>
        </template>
      </el-table-column>
      <el-table-column label="正式档案半（档案室）" min-width="200">
        <template #default="{ row }">
          <template v-if="row.official">
            <div>{{ row.official.data.archiveCode }} v{{ row.official.version }}：{{ row.official.data.conclusion }}</div>
            <div class="muted">复核：{{ row.official.review?.mark ?? '未复核' }}（{{ row.official.review?.marker ?? '—' }}）</div>
          </template>
          <span v-else class="muted">未建档</span>
        </template>
      </el-table-column>
      <el-table-column label="档案室操作" width="280">
        <template #default="{ row }">
          <el-button link size="small" type="primary" @click="openOfficial(row.treeId, row.official?.data)">维护正式档案</el-button>
          <el-button link size="small" type="success" @click="openReview(row.treeId, row.official?.review?.mark)">打复核标记</el-button>
          <el-button link size="small" type="danger" @click="askWithdraw(row.treeId)">撤档（留墓碑）</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 撤档墓碑 -->
    <div class="panel__subhead">🪦 撤档标记（再冒出同一株会被巡查对账拦回）</div>
    <el-table :data="store.tombstones" size="small" empty-text="暂无撤档记录">
      <el-table-column prop="treeId" label="树号" width="120" />
      <el-table-column label="撤档信息" min-width="260">
        <template #default="{ row }">{{ row.tombstone.at }} · {{ row.tombstone.by }} · {{ row.tombstone.reason }}</template>
      </el-table-column>
      <el-table-column label="操作" width="150">
        <template #default="{ row }">
          <el-button link size="small" type="warning" @click="store.reinstate(row.treeId)">档案室恢复误撤</el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>
</template>

<script setup lang="ts">
/**
 * 档案室对账台：冲突双版人工裁定、正式档案半与复核标记维护、撤档墓碑与恢复。
 */
import { computed, reactive } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useSyncStore } from '../../stores/syncStore'
import type { OfficialPayload } from '../../types/sync'
import type { ResolveChoice } from '../../utils/sync/reconcile'
import PatrolView from './PatrolView.vue'

const store = useSyncStore()
const mergeNotes = reactive<Record<string, string>>({})

const activeTrees = computed(() => store.trees.filter((tree) => tree.tombstone === null && !tree.legacy))

async function decide(treeId: string, choice: ResolveChoice): Promise<void> {
  const note = mergeNotes[treeId]?.trim()
  await store.decideConflict(treeId, choice, note ? makeMerged(treeId, note) : null)
  delete mergeNotes[treeId]
  ElMessage.success('冲突已人工裁定')
}

function makeMerged(treeId: string, note: string): import('../../types/sync').PatrolPayload {
  const tree = store.trees.find((item) => item.treeId === treeId)
  const base = tree?.conflict?.local.data
  return {
    treeCode: base?.treeCode ?? treeId,
    inspector: base?.inspector ?? '档案室',
    vigor: base?.vigor ?? '一般',
    inspectedAt: new Date().toISOString().slice(0, 10),
    note,
  }
}

async function openOfficial(treeId: string, prev?: OfficialPayload): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('正式档案结论（档案室那半）', '维护正式档案', {
      inputValue: prev?.conclusion ?? '',
      confirmButtonText: '保存',
    })
    if (typeof value !== 'string' || value.trim() === '') return
    await store.saveOfficial(treeId, {
      archiveCode: prev?.archiveCode ?? `档-${treeId}`,
      conclusion: value.trim(),
      note: prev?.note ?? '',
    })
    ElMessage.success('正式档案半已更新（巡查半未动）')
  } catch {
    /* 取消 */
  }
}

async function openReview(treeId: string, prevMark?: string): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('复核标记', '打复核标记', {
      inputValue: prevMark ?? '已复核',
      confirmButtonText: '保存',
    })
    if (typeof value !== 'string' || value.trim() === '') return
    await store.setReview(treeId, value.trim(), '李档')
    ElMessage.success('复核标记已落档')
  } catch {
    /* 取消 */
  }
}

async function askWithdraw(treeId: string): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('撤档原因（将保留墓碑并拦截复活）', '撤档', {
      inputValue: '误登非古树',
      confirmButtonText: '确认撤档',
      inputType: 'text',
    })
    if (typeof value !== 'string' || value.trim() === '') return
    await store.withdraw(treeId, value.trim())
    ElMessage.success('已撤档，巡查包再带回会被拦')
  } catch {
    /* 取消 */
  }
}
</script>

<style scoped>
.panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
}
.panel__tip {
  margin-bottom: 12px;
}
.panel__subhead {
  margin: 16px 0 8px;
  font-weight: 600;
}
.conflict {
  border: 1px solid #e6a23c;
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 14px;
  background: #fdf6ec;
}
.conflict__title {
  font-weight: 700;
  margin-bottom: 8px;
}
.conflict__sides {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.conflict__merge {
  margin: 10px 0;
}
.conflict__actions {
  display: flex;
  gap: 8px;
}
.muted {
  color: #909399;
  font-size: 12px;
}
</style>
