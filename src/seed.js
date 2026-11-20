'use strict';

/**
 * 本地造数：模拟展馆端与运输端各自的交单箱（outbox）。
 *
 * 场景（2026-11-20，时间单位：分钟，基准 08:00Z）：
 *   T+0   展馆装箱 PK-001：BOX-100 装入 4 件展品
 *   T+15  运输交接 TR-001：BOX-100 由展馆库房交给运输一队   ← 故意迟到，需「补交早到记录」
 *   T+30  运输转运 TR-002：BOX-100 途中换编号为 BOX-200      ← 两边都留了底，重复交单
 *   T+90  运输转运 TR-003：从 BOX-200 分出 2 件装入 BOX-300，转交运输二队（部分转交）
 *   T+180 展馆开箱 UN-901：BOX-200 到馆签收 2 件
 *   T+240 展馆开箱 UN-902：BOX-300 到馆签收 2 件
 *
 * 重复交单：PK-001 在展馆 outbox 里出现两次；TR-002 在两侧 outbox 各有一份。
 */
function buildSeed() {
  const T0 = Date.UTC(2026, 10, 20, 8, 0, 0);
  const T = (min) => T0 + min * 60 * 1000;

  const objects = [
    { id: 'EX-001', name: '青铜鼎' },
    { id: 'EX-002', name: '玉璧' },
    { id: 'EX-003', name: '瓷瓶' },
    { id: 'EX-004', name: '画卷' },
  ];

  const packAll = {
    slipId: 'PK-001', side: 'hall', kind: 'pack', boxLabel: 'BOX-100',
    items: ['EX-001', 'EX-002', 'EX-003', 'EX-004'],
    from: '展馆库房', to: '展馆库房', at: T(0), note: '出库装箱',
  };
  const renumber = {
    slipId: 'TR-002', side: 'transport', kind: 'transfer', boxLabel: 'BOX-100',
    renumberTo: 'BOX-200', from: '运输一队', to: '运输一队', at: T(30), note: '途中换箱号',
  };

  const hallOutbox = [
    packAll,
    { ...packAll },                                   // 同侧重复交单
    { ...renumber },                                  // 运输单的展馆留底（跨侧重复）
    {
      slipId: 'UN-901', side: 'hall', kind: 'unpack', boxLabel: 'BOX-200',
      items: ['EX-001', 'EX-002'], from: '运输一队', to: '展馆', at: T(180), note: '到馆开箱签收',
    },
    {
      slipId: 'UN-902', side: 'hall', kind: 'unpack', boxLabel: 'BOX-300',
      items: ['EX-003', 'EX-004'], from: '运输二队', to: '展馆', at: T(240), note: '到馆开箱签收',
    },
  ];

  const transportOutbox = [
    { ...renumber },                                  // 运输单正本
    {
      slipId: 'TR-003', side: 'transport', kind: 'transfer', boxLabel: 'BOX-200',
      items: ['EX-003', 'EX-004'], targetBox: 'BOX-300',
      from: '运输一队', to: '运输二队', at: T(90), note: '部分转交第二承运方',
    },
  ];

  // 早于签收（UN-901/UN-902）的迟到记录：展馆库房 → 运输一队 的交接
  const lateSlip = {
    slipId: 'TR-001', side: 'transport', kind: 'transfer', boxLabel: 'BOX-100',
    from: '展馆库房', to: '运输一队', at: T(15), note: '补录：装车交接',
  };

  return { objects, hallOutbox, transportOutbox, lateSlip };
}

module.exports = { buildSeed };
