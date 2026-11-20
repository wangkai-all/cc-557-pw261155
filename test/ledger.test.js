'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Ledger } = require('../src/ledger');
const { buildSeed } = require('../src/seed');

const T0 = Date.UTC(2026, 10, 20, 8, 0, 0);
const T = (min) => T0 + min * 60 * 1000;

function freshLedger() {
  const seed = buildSeed();
  const ledger = new Ledger();
  ledger.registerObjects(seed.objects);
  return { ledger, seed };
}

function collectAll(ledger, seed) {
  const hall = ledger.ingestBatch(seed.hallOutbox, 'hall');
  const transport = ledger.ingestBatch(seed.transportOutbox, 'transport');
  return { hall, transport };
}

// ---------- 正常流程 ----------

test('采集两边交接单：重复交单按单号去重，事件全部入链', () => {
  const { ledger, seed } = freshLedger();
  const { hall, transport } = collectAll(ledger, seed);

  assert.equal(hall.accepted, 4);      // PK-001、TR-002 留底、UN-901、UN-902
  assert.equal(hall.duplicates, 1);    // PK-001 重投
  assert.equal(transport.accepted, 1); // TR-003（TR-002 正本与展馆留底重复）
  assert.equal(transport.duplicates, 1);
  assert.equal(hall.accepted + transport.accepted, 5);
  assert.equal(ledger.events.length, 5);
  assert.equal(ledger.duplicates.length, 2);
});

test('状态由全部单据重放得出，而非只取最后一条', () => {
  const { ledger, seed } = freshLedger();
  collectAll(ledger, seed);

  // 最后一条单据是 UN-902（BOX-300 开箱），若只取最后一条，EX-001 将无处可查
  const ex1 = ledger.objectChain('EX-001');
  assert.equal(ex1.status, '已签收·展馆');
  assert.ok(ex1.hops >= 3, 'EX-001 的交接链应包含装箱/转运/签收多个环节');
  assert.deepEqual(ex1.chain.map((c) => c.kind), ['pack', 'transfer', 'unpack']);

  const snap = ledger.snapshot();
  for (const o of snap.objects) assert.equal(o.status, '已签收·展馆');
});

test('箱子换编号：按新/旧编号都能找到原箱并保留交接链', () => {
  const { ledger, seed } = freshLedger();
  collectAll(ledger, seed);

  const byOld = ledger.boxReport('BOX-100');
  const byNew = ledger.boxReport('BOX-200');
  assert.equal(byOld.found, true);
  assert.equal(byNew.found, true);
  assert.equal(byNew.canonical, 'BOX-100', '新编号应回溯到原箱');
  assert.deepEqual(byNew.labels, ['BOX-100', 'BOX-200']);
  assert.equal(byNew.renumbers.length, 1);
  assert.equal(byNew.renumbers[0].to, 'BOX-200');
  // 交接链跨两个编号：装箱(BOX-100)、换号转运、部分分出、开箱(BOX-200)
  assert.deepEqual(byNew.events.map((e) => e.slipId), ['PK-001', 'TR-002', 'TR-003', 'UN-901']);
});

test('部分转交：只分出部分展品，其余留在原箱', () => {
  const ledger = new Ledger();
  ledger.registerObjects([
    { id: 'A1', name: '甲' }, { id: 'A2', name: '乙' },
    { id: 'A3', name: '丙' }, { id: 'A4', name: '丁' },
  ]);
  ledger.ingest({ slipId: 'P1', side: 'hall', kind: 'pack', boxLabel: 'B1', items: ['A1', 'A2', 'A3', 'A4'], from: '展馆', at: T(0) });
  ledger.ingest({ slipId: 'T1', side: 'transport', kind: 'transfer', boxLabel: 'B1', items: ['A3', 'A4'], targetBox: 'B2', from: '展馆', to: '运输二队', at: T(10) });

  const b1 = ledger.boxReport('B1');
  const b2 = ledger.boxReport('B2');
  assert.deepEqual([...b1.contents].sort(), ['A1', 'A2']);
  assert.deepEqual([...b2.contents].sort(), ['A3', 'A4']);
  assert.equal(b2.holder, '运输二队');
  assert.equal(ledger.objectChain('A3').chain.at(-1).box, 'B2');
  assert.equal(ledger.objectChain('A1').chain.at(-1).box, 'B1');
  assert.equal(ledger.problems.length, 0);
});

test('补交早到记录：补上断点，交接链由异常恢复为完整', () => {
  const { ledger, seed } = freshLedger();
  collectAll(ledger, seed);

  // 补交前：TR-002 票面交方是运输一队，但台账里箱子还在展馆库房 => 断点
  assert.equal(ledger.problems.length, 1);
  assert.equal(ledger.problems[0].code, 'holder-mismatch');
  assert.equal(ledger.problems[0].slipId, 'TR-002');

  // 补交一条早于签收（UN-901/UN-902）的记录
  const r = ledger.ingest(seed.lateSlip);
  assert.equal(r.status, 'accepted');
  assert.equal(r.late, true, '发生时间早于已受理的最大时间，应标记为补录');

  assert.equal(ledger.problems.length, 0, '断点补齐后校验应通过');
  const ids = ledger.events.map((e) => e.slipId);
  assert.ok(ids.indexOf('TR-001') < ids.indexOf('TR-002'), '补交记录应按发生时间插回正确位置');
  assert.ok(ids.indexOf('TR-001') < ids.indexOf('UN-901'), '补交记录早于签收');

  const ex1 = ledger.objectChain('EX-001');
  assert.deepEqual(ex1.chain.map((c) => c.slipId), ['PK-001', 'TR-001', 'TR-002', 'UN-901']);
  assert.equal(ex1.chain[1].late, true);
});

// ---------- 异常流程 ----------

test('重复交单不重复生效', () => {
  const { ledger, seed } = freshLedger();
  const slip = seed.hallOutbox[0];
  assert.equal(ledger.ingest(slip).status, 'accepted');
  const again = ledger.ingest({ ...slip });
  assert.equal(again.status, 'duplicate');
  assert.equal(ledger.events.length, 1);
  assert.equal(ledger.objectChain('EX-001').hops, 1, '重复装箱不得让物件重复经手');
});

test('未知物件装箱：拒收且不污染台账', () => {
  const { ledger } = freshLedger();
  const r = ledger.ingest({ slipId: 'BAD-1', side: 'hall', kind: 'pack', boxLabel: 'BX', items: ['EX-999'], from: '展馆', at: T(0) });
  assert.equal(r.status, 'rejected');
  assert.equal(r.reason, 'unknown-object');
  assert.equal(ledger.events.length, 0);
  assert.equal(ledger.rejected.length, 1);
});

test('结构不合法的单据：拒收', () => {
  const { ledger } = freshLedger();
  assert.equal(ledger.ingest(null).status, 'rejected');
  assert.equal(ledger.ingest({ slipId: 'X1' }).status, 'rejected');           // 缺字段
  assert.equal(ledger.ingest({ slipId: 'X2', side: 'hall', kind: 'fly', boxLabel: 'B', at: 1 }).status, 'rejected'); // 未知类型
  assert.equal(ledger.rejected.length, 3);
  assert.equal(ledger.events.length, 0);
});

test('转运不在源箱中的物件：记录校验问题', () => {
  const ledger = new Ledger();
  ledger.registerObjects([{ id: 'A1', name: '甲' }, { id: 'A2', name: '乙' }]);
  ledger.ingest({ slipId: 'P1', side: 'hall', kind: 'pack', boxLabel: 'B1', items: ['A1'], from: '展馆', at: T(0) });
  ledger.ingest({ slipId: 'T1', side: 'transport', kind: 'transfer', boxLabel: 'B1', items: ['A2'], targetBox: 'B2', from: '展馆', to: '运输', at: T(10) });
  const codes = ledger.problems.map((p) => p.code);
  assert.ok(codes.includes('item-not-in-box'));
  assert.match(ledger.objectChain('A1').status, /^在箱 B1/, 'A1 不应被错误移动');
  assert.equal(ledger.boxReport('B1').contents.includes('A1'), true);
});

test('开箱未知箱号：记录校验问题', () => {
  const { ledger } = freshLedger();
  ledger.ingest({ slipId: 'U1', side: 'hall', kind: 'unpack', boxLabel: 'BOX-X', items: [], from: '运输', to: '展馆', at: T(0) });
  assert.equal(ledger.problems.length, 1);
  assert.equal(ledger.problems[0].code, 'unknown-box');
});

test('同一箱重复开箱：记录校验问题', () => {
  const ledger = new Ledger();
  ledger.registerObjects([{ id: 'A1', name: '甲' }]);
  ledger.ingest({ slipId: 'P1', side: 'hall', kind: 'pack', boxLabel: 'B1', items: ['A1'], from: '展馆', at: T(0) });
  ledger.ingest({ slipId: 'U1', side: 'hall', kind: 'unpack', boxLabel: 'B1', items: ['A1'], from: '展馆', to: '展馆', at: T(10) });
  ledger.ingest({ slipId: 'U2', side: 'hall', kind: 'unpack', boxLabel: 'B1', items: ['A1'], from: '展馆', to: '展馆', at: T(20) });
  const codes = ledger.problems.map((p) => p.code);
  assert.ok(codes.includes('box-already-opened'));
  assert.ok(codes.includes('item-not-in-box'));
});

test('重复补交同一条早到记录：第二次按重复忽略', () => {
  const { ledger, seed } = freshLedger();
  collectAll(ledger, seed);
  assert.equal(ledger.ingest(seed.lateSlip).status, 'accepted');
  const again = ledger.ingest({ ...seed.lateSlip });
  assert.equal(again.status, 'duplicate');
  assert.equal(ledger.events.filter((e) => e.slipId === 'TR-001').length, 1);
});

test('交接链断点：持有方与票面交方不一致被检出', () => {
  const ledger = new Ledger();
  ledger.registerObjects([{ id: 'A1', name: '甲' }]);
  ledger.ingest({ slipId: 'P1', side: 'hall', kind: 'pack', boxLabel: 'B1', items: ['A1'], from: '展馆', at: T(0) });
  // 跳过「展馆→运输」交接，直接由运输转运
  ledger.ingest({ slipId: 'T9', side: 'transport', kind: 'transfer', boxLabel: 'B1', from: '运输', to: '运输', at: T(10) });
  assert.equal(ledger.problems.length, 1);
  assert.equal(ledger.problems[0].code, 'holder-mismatch');
});
