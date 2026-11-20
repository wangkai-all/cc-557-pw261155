'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('HTTP：页面含 data-evidence-result，三个操作驱动状态变化', async (t) => {
  const server = createServer();
  const port = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${port}`;

  // 页面与证据区
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(html.includes('data-evidence-result'), '业务结果区应带 data-evidence-result 属性');
  assert.ok(html.includes('采集两边交接单'));
  assert.ok(html.includes('补交早到记录'));
  assert.ok(html.includes('打开物件交接链'));

  // 初始：无单据
  let state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.stats.events, 0);

  // 采集两边交接单：去重生效，断点暴露
  const collect = await (await fetch(`${base}/api/collect`, { method: 'POST' })).json();
  assert.equal(collect.totals.accepted, 5);
  assert.equal(collect.totals.duplicates, 2);
  assert.equal(collect.state.stats.problems, 1);
  assert.equal(collect.state.problems[0].code, 'holder-mismatch');

  // 补交早到记录：断点修复
  const late = await (await fetch(`${base}/api/late`, { method: 'POST' })).json();
  assert.equal(late.result.status, 'accepted');
  assert.equal(late.result.late, true);
  assert.equal(late.state.stats.problems, 0);

  // 打开物件交接链：完整四跳
  const chain = await (await fetch(`${base}/api/chain?object=EX-001`)).json();
  assert.deepEqual(chain.chain.map((c) => c.slipId), ['PK-001', 'TR-001', 'TR-002', 'UN-901']);
  assert.equal(chain.status, '已签收·展馆');

  // 箱位置报告：按新编号找到原箱
  const box = await (await fetch(`${base}/api/box?label=BOX-200`)).json();
  assert.equal(box.canonical, 'BOX-100');
  assert.deepEqual(box.labels, ['BOX-100', 'BOX-200']);

  // 异常：未知物件 / 未知箱 / 未知路由
  const badChain = await fetch(`${base}/api/chain?object=EX-999`);
  assert.equal(badChain.status, 404);
  const badBox = await fetch(`${base}/api/box?label=BOX-X`);
  assert.equal(badBox.status, 404);
  const notFound = await fetch(`${base}/nope`);
  assert.equal(notFound.status, 404);

  // 重置后可重新采集
  await fetch(`${base}/api/reset`, { method: 'POST' });
  state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.stats.events, 0);
});
