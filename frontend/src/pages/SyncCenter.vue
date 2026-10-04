<template>
  <div class="sync-page">
    <el-card shadow="never" class="sync-page__bar">
      <div class="sync-page__controls">
        <div class="sync-page__group">
          <span class="sync-page__label">当前模拟身份</span>
          <el-radio-group :model-value="store.currentOrigin" size="small" @update:model-value="store.switchOrigin">
            <el-radio-button label="tablet-a">一组平板 tablet-a</el-radio-button>
            <el-radio-button label="tablet-b">二组平板 tablet-b</el-radio-button>
          </el-radio-group>
        </div>
        <div class="sync-page__group">
          <span class="sync-page__label">回办公室链路</span>
          <el-switch
            :model-value="store.online"
            active-text="有信号"
            inactive-text="断网（模拟山上）"
            @update:model-value="store.setOnline"
          />
        </div>
        <el-button size="small" plain :loading="store.busy" @click="store.reseed()">重置演示数据</el-button>
      </div>
      <p class="sync-page__desc">
        平板管巡查单，档案室管正式档案与复核标记；两边都不再整包覆盖，回办公室只交巡查包、按各自来历对账。
      </p>
    </el-card>

    <el-tabs v-model="activeTab" class="sync-page__tabs">
      <el-tab-pane label="① 平板巡查" name="tablet">
        <TabletPanel />
      </el-tab-pane>
      <el-tab-pane label="② 交包传输（断网可试）" name="transfer">
        <TransferPanel />
      </el-tab-pane>
      <el-tab-pane label="③ 档案室对账" name="reconcile">
        <ReconcilePanel />
      </el-tab-pane>
      <el-tab-pane label="④ 老单升级" name="legacy">
        <LegacyPanel />
      </el-tab-pane>
      <el-tab-pane label="审计留痕" name="audit">
        <el-card shadow="never">
          <el-timeline>
            <el-timeline-item
              v-for="entry in store.audits"
              :key="entry.id"
              :timestamp="entry.at"
              :type="auditType(entry.action)"
            >
              <el-tag size="small" effect="plain">{{ entry.action }}</el-tag>
              <b class="sync-page__audit-tree">{{ entry.treeId }}</b>
              <span class="muted">[{{ entry.origin }}]</span>
              <div class="muted">{{ entry.detail }}</div>
            </el-timeline-item>
          </el-timeline>
          <el-empty v-if="store.audits.length === 0" description="还没有对账动作，去交个巡查包" />
        </el-card>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
/**
 * 同步中心页：聚合平板巡查、交包传输、档案室对账、老单升级四个面板与审计留痕。
 * 两侧物理隔离：平板库无正式档案字段，档案室库才有正式档案 / 复核 / 墓碑。
 */
import { onMounted, ref } from 'vue'
import { useSyncStore } from '@/stores/syncStore'
import type { AuditAction } from '@/types/sync'
import TabletPanel from '@/components/sync/TabletPanel.vue'
import TransferPanel from '@/components/sync/TransferPanel.vue'
import ReconcilePanel from '@/components/sync/ReconcilePanel.vue'
import LegacyPanel from '@/components/sync/LegacyPanel.vue'

const store = useSyncStore()
const activeTab = ref('tablet')

onMounted(() => {
  void store.init()
})

function auditType(action: AuditAction): 'primary' | 'success' | 'warning' | 'danger' | 'info' {
  if (action === 'patrol-adopted' || action.startsWith('conflict-resolve')) return 'success'
  if (action === 'resurrect-blocked') return 'danger'
  if (action === 'conflict-held') return 'warning'
  return 'primary'
}
</script>

<style scoped>
.sync-page__bar {
  margin-bottom: 14px;
}
.sync-page__controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 20px;
}
.sync-page__group {
  display: flex;
  align-items: center;
  gap: 10px;
}
.sync-page__label {
  font-size: 13px;
  color: #606266;
}
.sync-page__desc {
  margin: 10px 0 0;
  font-size: 12px;
  color: #909399;
}
.sync-page__tabs {
  margin-top: 6px;
}
.sync-page__audit-tree {
  margin: 0 8px;
}
.muted {
  color: #909399;
  font-size: 12px;
}
</style>
