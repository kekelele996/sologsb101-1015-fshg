/**
 * 老巡查单升级（纯逻辑）：
 * - 旧单没有来历，按「登记人 -> 来历」映射补一方 origin；
 * - 登记人不在映射表：列入 unmapped，交人工补映射，绝不乱猜一个设备；
 * - 补登后的树标记 legacy=true，只进入档案室归档，永不参与对账（ack 不写、巡查包复活也被拦）。
 */
import type { OriginId, SyncTree } from '../../types/sync'
import type { LegacySheet, LegacyUpgradeResult } from '../../types/legacy'
import { nowIso } from '../id'

/** 落库端口：只写 legacy 归档树 */
export interface LegacyPort {
  getTree(treeId: string): Promise<SyncTree | null>
  putTree(tree: SyncTree): Promise<void>
}

/**
 * 升级一批老巡查单。
 * @param registrarToOrigin 登记人 -> 来历（平板）映射
 */
export async function upgradeLegacySheets(
  port: LegacyPort,
  sheets: LegacySheet[],
  registrarToOrigin: Record<string, OriginId>,
  at = nowIso(),
): Promise<LegacyUpgradeResult> {
  const result: LegacyUpgradeResult = { archived: [], unmapped: [] }

  for (const sheet of sheets) {
    const origin = registrarToOrigin[sheet.registrar]
    if (origin === undefined) {
      result.unmapped.push({ id: sheet.id, registrar: sheet.registrar })
      continue
    }

    const existing = (await port.getTree(sheet.id)) ?? {
      treeId: sheet.id,
      patrol: null,
      official: null,
      tombstone: null,
      ack: {},
      conflict: null,
      legacy: false,
    }

    // 老单只归档：补一方来历作为溯源，但不写 ack —— 从根上保证它不会被当成可对账版本
    await port.putTree({
      ...existing,
      treeId: sheet.id,
      legacy: true,
      patrol: { origin, version: 0, revisedAt: at, data: sheet.payload },
    })
    result.archived.push({ id: sheet.id, origin, treeId: sheet.id })
  }

  return result
}
