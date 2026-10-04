/**
 * 同步域核心规则测试（node:test + tsx，无浏览器依赖）。
 * 运行：npm run test:sync
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MemorySyncStore } from '../src/utils/sync/memoryStore'
import {
  RESOLVE_CHOICE,
  emptyTree,
  markReview,
  reconcilePatrol,
  reinstateTree,
  resolveConflict,
  upsertOfficial,
  withdrawTree,
} from '../src/utils/sync/reconcile'
import { chunkPackage, createTabletState, saveDraft, sealPackage, selectUnackedChunks } from '../src/utils/sync/tablet'
import { receiveChunk, resumePackage, sendPackage } from '../src/utils/sync/transfer'
import { upgradeLegacySheets } from '../src/utils/sync/legacy'
import { RECONCILE_STATUS } from '../src/types/sync'
import type { PatrolItem, PatrolPayload } from '../src/types/sync'

const T = '2026-10-04T00:00:00.000Z'

function patrol(inspector: string, note: string, vigor = '一般'): PatrolPayload {
  return { treeCode: '京-01-0007', inspector, vigor, inspectedAt: '2026-10-04', note }
}

function item(treeId: string, version: number, note: string): PatrolItem {
  return { treeId, version, payload: patrol('张巡', note) }
}

describe('对账：各管一半 + 按来历认最新版', () => {
  it('认下本来历新版时，正式档案半与复核标记原样保留（平板顶不掉档案室那半）', async () => {
    const store = new MemorySyncStore()
    const tree = emptyTree('tree-1')
    tree.patrol = { origin: 'tablet-a', version: 1, revisedAt: T, data: patrol('张巡', '旧巡查') }
    tree.ack['tablet-a'] = 1
    tree.official = {
      origin: 'archive-1',
      version: 2,
      revisedAt: T,
      data: { archiveCode: '档-001', conclusion: '正式结论：长势一般', note: '' },
      review: { mark: '已复核', marker: '李档', markedAt: T },
    }
    store.seed(tree)

    const res = await reconcilePatrol(store, 'tablet-a', item('tree-1', 2, '新巡查：有少量落叶'), T)
    assert.equal(res.status, RECONCILE_STATUS.adopted)

    const after = (await store.getTree('tree-1'))!
    assert.equal(after.patrol?.data.note, '新巡查：有少量落叶')
    assert.equal(after.patrol?.version, 2)
    // 档案室那半一动没动
    assert.equal(after.official?.data.conclusion, '正式结论：长势一般')
    assert.equal(after.official?.review?.mark, '已复核')
    assert.equal(after.official?.version, 2)
  })

  it('同一来历的旧版不能顶掉已认下的新版/复核结论（旧版顶账问题）', async () => {
    const store = new MemorySyncStore()
    await reconcilePatrol(store, 'tablet-a', item('tree-1', 3, 'v3 最新'), T)
    const res = await reconcilePatrol(store, 'tablet-a', item('tree-1', 1, 'v1 旧包重放'), T)
    assert.equal(res.status, RECONCILE_STATUS.staleSkipped)
    const after = (await store.getTree('tree-1'))!
    assert.equal(after.patrol?.version, 3)
    assert.equal(after.patrol?.data.note, 'v3 最新')
  })

  it('两个来历各改各的：保留两版挂冲突，不自动覆盖', async () => {
    const store = new MemorySyncStore()
    await reconcilePatrol(store, 'tablet-a', item('tree-1', 1, 'A 设备巡查'), T)
    const res = await reconcilePatrol(store, 'tablet-b', item('tree-1', 1, 'B 设备也巡查了这棵'), T)
    assert.equal(res.status, RECONCILE_STATUS.conflictHeld)
    const after = (await store.getTree('tree-1'))!
    assert.equal(after.conflict?.local.data.note, 'A 设备巡查')
    assert.equal(after.conflict?.incoming.data.note, 'B 设备也巡查了这棵')
    // 在档巡查半仍是先认下的 A，未被 B 覆盖
    assert.equal(after.patrol?.origin, 'tablet-a')
  })

  it('冲突裁定：认来人 / 认在档 / 人工合并，三选一后清冲突，重试不再起冲突', async () => {
    const store = new MemorySyncStore()
    await reconcilePatrol(store, 'tablet-a', item('tree-1', 1, 'A 版'), T)
    await reconcilePatrol(store, 'tablet-b', item('tree-1', 1, 'B 版'), T)

    await resolveConflict(store, 'tree-1', RESOLVE_CHOICE.merge, { origin: 'archive-1', data: patrol('张巡', '人定合并版', '衰弱') }, T)
    let after = (await store.getTree('tree-1'))!
    assert.equal(after.conflict, null)
    assert.equal(after.patrol?.data.note, '人定合并版')
    assert.equal(after.ack['tablet-a'], 1)
    assert.equal(after.ack['tablet-b'], 1)

    // B 的同版旧包重试，不能把人定结果再顶出冲突
    const replay = await reconcilePatrol(store, 'tablet-b', item('tree-1', 1, 'B 版重放'), T)
    assert.equal(replay.status, RECONCILE_STATUS.staleSkipped)
    after = (await store.getTree('tree-1'))!
    assert.equal(after.conflict, null)
    assert.equal(after.patrol?.data.note, '人定合并版')

    // 认在档分支
    const store2 = new MemorySyncStore()
    await reconcilePatrol(store2, 'tablet-a', item('t', 1, 'A'), T)
    await reconcilePatrol(store2, 'tablet-b', item('t', 1, 'B'), T)
    await resolveConflict(store2, 't', RESOLVE_CHOICE.local, null, T)
    assert.equal((await store2.getTree('t'))!.patrol?.data.note, 'A')
  })
})

describe('撤档墓碑：撤掉的树不能被巡查包带回', () => {
  it('撤档后同一株再冒头被拦截，且不复活；档案室外显式恢复才行', async () => {
    const store = new MemorySyncStore()
    await reconcilePatrol(store, 'tablet-a', item('tree-x', 1, '正常巡查'), T)
    await upsertOfficial(store, 'tree-x', 'archive-1', { archiveCode: '档-X', conclusion: '在档', note: '' }, T)
    await withdrawTree(store, 'tree-x', 'archive-1', '误登非古树，撤档', T)

    const blocked = await reconcilePatrol(store, 'tablet-a', item('tree-x', 2, '下趟巡查又冒出这株'), T)
    assert.equal(blocked.status, RECONCILE_STATUS.resurrectBlocked)
    const after = (await store.getTree('tree-x'))!
    assert.notEqual(after.tombstone, null)
    assert.equal(after.patrol?.version, 1) // 旧巡查留在墓碑前状态，没被 v2 带回

    // 巡查包永远不能自行恢复：再投仍是拦截
    const again = await reconcilePatrol(store, 'tablet-a', item('tree-x', 2, '再试'), T)
    assert.equal(again.status, RECONCILE_STATUS.resurrectBlocked)
  })

  it('档案室恢复误撤树后恢复正常对账', async () => {
    const store = new MemorySyncStore()
    await reconcilePatrol(store, 'tablet-a', item('tree-y', 1, '巡查'), T)
    await withdrawTree(store, 'tree-y', 'archive-1', '误撤', T)
    await reinstateTree(store, 'tree-y', 'archive-1', T)
    const res = await reconcilePatrol(store, 'tablet-a', item('tree-y', 2, '恢复后巡查'), T)
    assert.equal(res.status, RECONCILE_STATUS.adopted)
    assert.equal((await store.getTree('tree-y'))!.patrol?.version, 2)
  })

  it('复核标记只有档案室能打，且不碰巡查半', async () => {
    const store = new MemorySyncStore()
    await reconcilePatrol(store, 'tablet-a', item('tree-r', 1, '巡查'), T)
    await upsertOfficial(store, 'tree-r', 'archive-1', { archiveCode: '档-R', conclusion: '结论', note: '' }, T)
    await markReview(store, 'tree-r', 'archive-1', { mark: '退回补查', marker: '李档', markedAt: T })
    const after = (await store.getTree('tree-r'))!
    assert.equal(after.official?.review?.mark, '退回补查')
    assert.equal(after.patrol?.version, 1)
  })
})

describe('传输：分片、断一半、按那头重试、已认下不受影响', () => {
  it('传到一半断网：已认片保留，恢复后从断点续传，重复片幂等', async () => {
    const store = new MemorySyncStore()
    const tablet = createTabletState('tablet-a')
    ;['t1', 't2', 't3', 't4', 't5'].forEach((id) => saveDraft(tablet, id, patrol('张巡', id)))
    const pkg = sealPackage(tablet)!
    assert.equal(pkg.items.length, 5)
    const chunks = chunkPackage(pkg, 2) // seq0:2条 seq1:2条 seq2:1条

    // 第一次：第 2 片（seq1）投到一半断网
    await receiveChunk(store, chunks[0])
    await assert.rejects(() => sendOne(store, chunks[1], /*failOnItem*/ 1), /网络中断/)
    // seq1 在第一片 item 已认下后才整体落 session：失败发生在对账前则该片不完整
    let session = await store.getSession(pkg.packageId)
    assert.ok(session)
    assert.ok((session!.lastSeq === 0) || (session!.lastSeq === 1))

    // 网络恢复：只续传未确认片
    const outcome = await resumePackage(store, chunks, (c) => sendOne(store, c, -1))
    assert.equal(outcome.complete, true)
    assert.equal(outcome.ackedSeq, 2)

    // 整包最终 5 条 adopted
    assert.equal(outcome.results.filter((r) => r.status === RECONCILE_STATUS.adopted).length, 5)

    // 重复投递整片：原样回执，不重复对账（审计只应有 5 条 patrol-adopted）
    const dup = await receiveChunk(store, chunks[0])
    assert.equal(dup.seq, 0)
    session = await store.getSession(pkg.packageId)
    assert.equal(session?.status, 'complete')
    const adoptedAudits = store.audits.filter((a) => a.action === 'patrol-adopted')
    assert.equal(adoptedAudits.length, 5)
  })

  it('同一包重传，已认下那头不受影响（旧版重试变 stale，不回滚）', async () => {
    const store = new MemorySyncStore()
    const tablet = createTabletState('tablet-a')
    saveDraft(tablet, 't1', patrol('张巡', 'v1'))
    const pkg1 = sealPackage(tablet)!
    await sendPackage(store, chunkPackage(pkg1, 5), (c) => receiveChunk(store, c))

    // 平板改了 t1 再封第二包
    saveDraft(tablet, 't1', patrol('张巡', 'v2'))
    const pkg2 = sealPackage(tablet)!
    await sendPackage(store, chunkPackage(pkg2, 5), (c) => receiveChunk(store, c))
    assert.equal((await store.getTree('t1'))!.patrol?.data.note, 'v2')

    // 旧包因网络重试又被整包重投：pkg1 的 v1 已认下过，按旧版跳过
    const outcome = await resumePackage(store, chunkPackage(pkg1, 5), (c) => receiveChunk(store, c))
    // pkg1 会话已 complete，直接完成，不产生新对账
    assert.equal(outcome.complete, true)
    assert.equal((await store.getTree('t1'))!.patrol?.data.note, 'v2')
  })
})

describe('老巡查单升级：按登记人补一方，只归档不对账', () => {
  it('登记人映射得到来历则归档；映射不到列 unmapped；归档树不参与对账', async () => {
    const store = new MemorySyncStore()
    const sheets = [
      { id: 'old-1', registrar: '王护', payload: patrol('王护', '2019 年老单'), recordedAt: '2019-05-01' },
      { id: 'old-2', registrar: '陌生登记员', payload: patrol('陌生登记员', '没人认识的登记人'), recordedAt: '2018-01-01' },
    ]
    const up = await upgradeLegacySheets(store, sheets, { 王护: 'tablet-a' })
    assert.deepEqual(up.archived.map((a) => a.id), ['old-1'])
    assert.deepEqual(up.unmapped.map((u) => u.id), ['old-2'])

    const archived = (await store.getTree('old-1'))!
    assert.equal(archived.legacy, true)
    assert.equal(archived.ack['tablet-a'], undefined)

    // 老单不参与对账：即使来个高版本也跳过，不顶正式账
    const res = await reconcilePatrol(store, 'tablet-a', item('old-1', 99, '想顶老档'), T)
    assert.equal(res.status, RECONCILE_STATUS.legacySkipped)
    assert.equal((await store.getTree('old-1'))!.patrol?.data.note, '2019 年老单')
  })
})

describe('平板封包：只装巡查半，自管版本', () => {
  it('只封未交更新，封包后再改生成下一版；空包不传', () => {
    const tablet = createTabletState('tablet-a')
    saveDraft(tablet, 't1', patrol('张巡', 'a'))
    const p1 = sealPackage(tablet)!
    assert.equal(p1.items.length, 1)
    assert.equal(sealPackage(tablet), null) // 没有未交更新
    saveDraft(tablet, 't1', patrol('张巡', 'b'))
    const p2 = sealPackage(tablet)!
    assert.equal(p2.items[0].version, 2)
    assert.equal(p1.packageId === p2.packageId, false)
  })

  it('selectUnackedChunks 据接收端 ack 只挑未认片', () => {
    const tablet = createTabletState('tablet-a')
    ;['a', 'b', 'c', 'd', 'e'].forEach((id) => saveDraft(tablet, id, patrol('张', id)))
    const pkg = sealPackage(tablet)!
    const chunks = chunkPackage(pkg, 2)
    const picked = selectUnackedChunks(pkg, [{ seq: 0, count: 2, results: [] }], 2)
    assert.deepEqual(picked.map((c) => c.seq), [1, 2])
  })
})

/** 测试用投递：可选在某条 item 上模拟断网（片整体未确认） */
async function sendOne(store: MemorySyncStore, chunk: import('../src/types/transfer').PackageChunk, failOnItem: number) {
  if (failOnItem >= 0 && chunk.items.some((_, i) => i === failOnItem)) {
    throw new Error('网络中断：传输只完成一半')
  }
  return receiveChunk(store, chunk)
}
