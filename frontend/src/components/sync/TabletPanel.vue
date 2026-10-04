<template>
  <el-card shadow="never" class="panel">
    <template #header>
      <div class="panel__head">
        <span>📋 平板巡查（离线可录 · 只含巡查半）</span>
        <el-tag size="small" type="info">{{ store.currentOrigin }}</el-tag>
      </div>
    </template>

    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="平板本地只有巡查单，结构上不含正式档案与复核标记——那半永远在档案室。"
      class="panel__tip"
    />

    <el-form :model="form" inline class="panel__form" @submit.prevent>
      <el-form-item label="树号">
        <el-input v-model="form.treeId" placeholder="如 sync-001" style="width: 150px" />
      </el-form-item>
      <el-form-item label="编号">
        <el-input v-model="form.treeCode" placeholder="古树编号" style="width: 140px" />
      </el-form-item>
      <el-form-item label="巡查人">
        <el-input v-model="form.inspector" placeholder="巡查人" style="width: 110px" />
      </el-form-item>
      <el-form-item label="长势">
        <el-select v-model="form.vigor" style="width: 100px">
          <el-option v-for="v in vigorOptions" :key="v" :label="v" :value="v" />
        </el-select>
      </el-form-item>
      <el-form-item label="现场记录">
        <el-input v-model="form.note" placeholder="现场记录" style="width: 260px" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" :loading="store.busy" @click="saveDraftRow">保存巡查单（离线）</el-button>
      </el-form-item>
    </el-form>

    <el-table :data="store.tabletDrafts" size="small" empty-text="本台平板暂无巡查草稿">
      <el-table-column prop="treeId" label="树号" width="130" />
      <el-table-column label="巡查内容" min-width="260">
        <template #default="{ row }">
          <div>{{ row.payload.treeCode }} · {{ row.payload.inspector }} · {{ row.payload.vigor }}</div>
          <div class="muted">{{ row.payload.note }}</div>
        </template>
      </el-table-column>
      <el-table-column label="本台版本" width="110">
        <template #default="{ row }">
          v{{ row.version }}
          <el-tag v-if="row.sealedVersion >= row.version" size="small" type="success">已交</el-tag>
          <el-tag v-else size="small" type="warning">待交</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="120">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="editAgain(row)">再改一版</el-button>
        </template>
      </el-table-column>
    </el-table>

    <div class="panel__footer">
      <el-button type="success" :disabled="pendingCount === 0" @click="seal">
        回办公室封巡查包（{{ pendingCount }} 条待交）
      </el-button>
      <span class="muted">封包后内容不可变；再改同一株会生成下一版。</span>
    </div>
  </el-card>
</template>

<script setup lang="ts">
/**
 * 平板巡查面板：离线起草 / 修改巡查单（本设备自管版本）、封不可变巡查包。
 */
import { computed, reactive } from 'vue'
import { ElMessage } from 'element-plus'
import { useSyncStore } from '../../stores/syncStore'
import type { PatrolPayload } from '../../types/sync'
import { today } from '../../utils/id'

const store = useSyncStore()
const vigorOptions = ['旺盛', '一般', '衰弱', '濒危']

const form = reactive({
  treeId: '',
  treeCode: '',
  inspector: '',
  vigor: '一般',
  note: '',
})

const pendingCount = computed<number>(() => store.tabletDrafts.filter((row) => row.version > row.sealedVersion).length)

async function saveDraftRow(): Promise<void> {
  if (form.treeId.trim() === '' || form.note.trim() === '') {
    ElMessage.warning('树号与现场记录必填')
    return
  }
  const payload: PatrolPayload = {
    treeCode: form.treeCode.trim() || form.treeId.trim(),
    inspector: form.inspector.trim() || '未署名',
    vigor: form.vigor,
    inspectedAt: today(),
    note: form.note.trim(),
  }
  await store.saveTabletDraft(form.treeId.trim(), payload)
  ElMessage.success('巡查单已离线保存到本台平板')
  form.note = ''
}

function editAgain(row: { treeId: string; payload: PatrolPayload }): void {
  form.treeId = row.treeId
  form.treeCode = row.payload.treeCode
  form.inspector = row.payload.inspector
  form.vigor = row.payload.vigor
  form.note = `${row.payload.note}（补充）`
}

async function seal(): Promise<void> {
  const pkg = await store.sealCurrentPackage()
  if (pkg) ElMessage.success(`巡查包 ${pkg.packageId.slice(0, 12)} 已封好，可到「交包传输」发送`)
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
.panel__form {
  margin-bottom: 4px;
}
.panel__footer {
  margin-top: 14px;
  display: flex;
  align-items: center;
  gap: 12px;
}
.muted {
  color: #909399;
  font-size: 12px;
}
</style>
