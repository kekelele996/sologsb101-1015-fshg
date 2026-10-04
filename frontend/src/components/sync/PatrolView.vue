<template>
  <div class="patrol-view">
    <div class="patrol-view__row"><span>编号</span><b>{{ half.data.treeCode }}</b></div>
    <div class="patrol-view__row"><span>巡查人</span><b>{{ half.data.inspector }}</b></div>
    <div class="patrol-view__row"><span>长势</span><VigorTag :vigor="vigorValue" /></div>
    <div class="patrol-view__row"><span>日期</span><b>{{ half.data.inspectedAt }}</b></div>
    <div class="patrol-view__note">{{ half.data.note }}</div>
    <div class="patrol-view__meta muted">{{ half.origin }} · v{{ half.version }} · {{ half.revisedAt.slice(0, 16) }}</div>
  </div>
</template>

<script setup lang="ts">
/** 巡查半只读视图：冲突双版、台账巡查列共用 */
import { computed } from 'vue'
import type { PatrolHalf } from '../../types/sync'
import type { Vigor } from '../../types/review'
import VigorTag from '../common/VigorTag.vue'

const props = defineProps<{ half: PatrolHalf }>()

const VIGORS: Vigor[] = ['旺盛', '一般', '衰弱', '濒危']
const vigorValue = computed<Vigor>(() => (VIGORS.includes(props.half.data.vigor as Vigor) ? (props.half.data.vigor as Vigor) : '一般'))
</script>

<style scoped>
.patrol-view__row {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  margin-bottom: 4px;
}
.patrol-view__row span {
  color: #909399;
}
.patrol-view__note {
  margin-top: 6px;
  font-size: 13px;
}
.patrol-view__meta {
  margin-top: 8px;
}
.muted {
  color: #909399;
  font-size: 12px;
}
</style>
