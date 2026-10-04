<template>
  <el-card shadow="never" class="panel">
    <template #header>
      <div class="panel__head">
        <span>📶 回办公室交巡查包（分片续传 · 幂等）</span>
        <div class="panel__switch">
          <span class="muted">链路：</span>
          <el-switch
            :model-value="store.online"
            active-text="有信号"
            inactive-text="断网"
            @update:model-value="store.setOnline"
          />
        </div>
      </div>
    </template>

    <el-alert
      :type="store.online ? 'success' : 'danger'"
      :closable="false"
      show-icon
      :title="
        store.online
          ? '网络正常：按片送达，档案室逐片认账。'
          : '断网中：发送会停在断点；已认下的片不回滚，恢复后对同一包「续传」即可。'
      "
      class="panel__tip"
    />

    <el-table :data="store.sentPackages" size="small" empty-text="还没有封好的巡查包，先到「平板巡查」封包">
      <el-table-column label="巡查包" min-width="220">
        <template #default="{ row }">
          <div>{{ row.pkg.packageId }}</div>
          <div class="muted">{{ row.pkg.origin }} · {{ row.pkg.items.length }} 条 · 共 {{ row.chunks.length }} 片</div>
        </template>
      </el-table-column>
      <el-table-column label="接收断点" width="200">
        <template #default="{ row }">
          <el-tag v-if="sessionOf(row.pkg.packageId)?.status === 'complete'" type="success" size="small">已全部认下</el-tag>
          <el-tag v-else type="warning" size="small">
            已认到第 {{ (sessionOf(row.pkg.packageId)?.lastSeq ?? -1) + 1 }} / {{ row.chunks.length }} 片
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="180">
        <template #default="{ row }">
          <el-button
            :type="store.online ? 'primary' : 'danger'"
            size="small"
            :loading="store.busy"
            @click="store.sendPackageToArchive(row.pkg)"
          >
            {{ sessionOf(row.pkg.packageId) && sessionOf(row.pkg.packageId)!.status !== 'complete' ? '续传 / 发送' : '重投（幂等）' }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-alert
      v-if="store.lastError"
      type="error"
      :closable="false"
      show-icon
      :title="store.lastError"
      class="panel__tip"
    />

    <template v-if="store.lastResults.length > 0">
      <div class="panel__subhead">最近一包的逐条对账结论</div>
      <el-table :data="store.lastResults" size="small" max-height="240" border>
        <el-table-column prop="treeId" label="树号" width="120" />
        <el-table-column label="来历 / 版本" width="150">
          <template #default="{ row }">{{ row.incomingOrigin }} v{{ row.incomingVersion }}</template>
        </el-table-column>
        <el-table-column label="结论" width="130">
          <template #default="{ row }"><ReconcileStatusTag :status="row.status" /></template>
        </el-table-column>
        <el-table-column prop="detail" label="说明" min-width="260" />
      </el-table>
    </template>
  </el-card>
</template>

<script setup lang="ts">
/**
 * 交包传输面板：在线 / 断网开关、逐片发送与断点续传、幂等重投、逐条对账结论展示。
 */
import { useSyncStore } from '../../stores/syncStore'
import ReconcileStatusTag from './ReconcileStatusTag.vue'

const store = useSyncStore()

function sessionOf(packageId: string) {
  return store.sessions.find((session) => session.packageId === packageId) ?? null
}
</script>

<style scoped>
.panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
}
.panel__switch {
  display: flex;
  align-items: center;
  gap: 8px;
}
.panel__tip {
  margin-bottom: 12px;
}
.panel__subhead {
  margin: 14px 0 8px;
  font-weight: 600;
}
.muted {
  color: #909399;
  font-size: 12px;
}
</style>
