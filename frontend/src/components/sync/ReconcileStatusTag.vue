<template>
  <el-tag :type="tagType" effect="plain" size="small" disable-transitions>{{ labelMap[status] ?? status }}</el-tag>
</template>

<script setup lang="ts">
/**
 * 对账结论标签：把 ReconcileStatus 统一渲染成中文彩色标签，
 * 供巡查包传输结果、会话明细等面板复用。
 */
import { computed } from 'vue'
import type { ReconcileStatus } from '../../types/sync'
import { RECONCILE_STATUS } from '../../types/sync'

const props = defineProps<{ status: ReconcileStatus }>()

const labelMap: Record<ReconcileStatus, string> = {
  [RECONCILE_STATUS.adopted]: '认下新版',
  [RECONCILE_STATUS.staleSkipped]: '旧版跳过',
  [RECONCILE_STATUS.conflictHeld]: '两版待人定',
  [RECONCILE_STATUS.resurrectBlocked]: '撤档已拦回',
  [RECONCILE_STATUS.legacySkipped]: '老单只归档',
}

const tagType = computed<'success' | 'info' | 'warning' | 'danger'>(() => {
  switch (props.status) {
    case RECONCILE_STATUS.adopted:
      return 'success'
    case RECONCILE_STATUS.conflictHeld:
      return 'warning'
    case RECONCILE_STATUS.resurrectBlocked:
      return 'danger'
    default:
      return 'info'
  }
})
</script>
