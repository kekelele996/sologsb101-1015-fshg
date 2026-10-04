/**
 * 老巡查单升级类型：旧巡查单没有来历（origin / version 缺失）。
 * 升级时按「登记人 -> 来历」补一方，老单只归档、永不参与对账。
 */
import type { OriginId, PatrolPayload } from './sync'

/** 升级前的老巡查单：无来历字段 */
export interface LegacySheet {
  id: string
  /** 登记人：用于映射补登来历 */
  registrar: string
  payload: PatrolPayload
  /** 原系统的登记时间 */
  recordedAt: string
}

/** 升级结果 */
export interface LegacyUpgradeResult {
  /** 成功补登来历并归档的条目 */
  archived: { id: string; origin: OriginId; treeId: string }[]
  /** 登记人在映射表中找不到来历、需人工处理的条目 */
  unmapped: { id: string; registrar: string }[]
}
