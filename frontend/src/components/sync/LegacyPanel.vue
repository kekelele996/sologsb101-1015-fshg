<template>
  <el-card shadow="never" class="panel">
    <template #header>
      <div class="panel__head">
        <span>📚 老巡查单升级（没来历 · 按登记人补一方 · 只归档不对账）</span>
        <el-button size="small" :loading="store.busy" type="primary" @click="upgrade">升级补登并归档</el-button>
      </div>
    </template>

    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="老单没有 origin / version：升级时只按「登记人 → 来历」补一方；补不出来历的列出来人工指定，绝不乱猜。归档后标记为老单，永不参与巡查对账。"
      class="panel__tip"
    />

    <el-table :data="store.legacySheets" size="small" empty-text="没有待升级的老巡查单">
      <el-table-column prop="id" label="老单号" width="150" />
      <el-table-column prop="registrar" label="登记人" width="120" />
      <el-table-column label="内容" min-width="260">
        <template #default="{ row }">{{ row.payload.treeCode }} · {{ row.payload.inspector }} · {{ row.payload.note }}</template>
      </el-table-column>
      <el-table-column label="来历补登" width="260">
        <template #default="{ row }">
          <el-select
            :model-value="mapping[row.registrar] ?? ''"
            placeholder="选择登记人所属来历"
            size="small"
            @update:model-value="(v: string) => setMap(row.registrar, v)"
          >
            <el-option label="tablet-a（一组平板）" value="tablet-a" />
            <el-option label="tablet-b（二组平板）" value="tablet-b" />
          </el-select>
          <el-tag v-if="!mapping[row.registrar]" size="small" type="danger" class="panel__warn">未映射</el-tag>
        </template>
      </el-table-column>
    </el-table>

    <el-alert
      v-if="store.lastUpgrade"
      :type="store.lastUpgrade.unmapped.length > 0 ? 'warning' : 'success'"
      :closable="false"
      show-icon
      class="panel__tip"
      :title="
        `已归档 ${store.lastUpgrade.archived.length} 条（只归档不对账）` +
        (store.lastUpgrade.unmapped.length > 0 ? `；${store.lastUpgrade.unmapped.length} 条来历不明待人工指定` : '')
      "
    />

    <div v-if="store.legacyTrees.length > 0" class="panel__subhead">
      已归档老单（{{ store.legacyTrees.length }}）：这些树不进对账，巡查包也顶不进正式账
    </div>
  </el-card>
</template>

<script setup lang="ts">
/**
 * 老巡查单升级面板：按登记人补来历、归档、展示未映射项与归档结果。
 */
import { reactive } from 'vue'
import { ElMessage } from 'element-plus'
import { useSyncStore } from '../../stores/syncStore'

const store = useSyncStore()

/** 登记人 -> 来历（与 store 内默认映射保持一致的初始视图） */
const mapping = reactive<Record<string, string>>({
  王护: 'tablet-a',
  赵巡: 'tablet-b',
})

async function setMap(registrar: string, origin: string): Promise<void> {
  mapping[registrar] = origin
  await store.mapUnknownRegistrar(registrar, origin)
}

async function upgrade(): Promise<void> {
  const result = await store.upgradeLegacy()
  if (result.unmapped.length > 0) {
    ElMessage.warning(`已归档 ${result.archived.length} 条；${result.unmapped.length} 条来历不明，请指定后再升级`)
  } else {
    ElMessage.success(`已归档 ${result.archived.length} 条老单（不参与对账）`)
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
  margin: 12px 0;
}
.panel__warn {
  margin-left: 8px;
}
.panel__subhead {
  margin-top: 14px;
  font-weight: 600;
}
</style>
