'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Ledger } = require('./src/ledger');
const { buildSeed } = require('./src/seed');

const INDEX_HTML = path.join(__dirname, 'public', 'index.html');

/** 每个服务实例一套独立台账，方便测试与重置。 */
function createContext() {
  const seed = buildSeed();
  const ledger = new Ledger();
  ledger.registerObjects(seed.objects);
  return { ledger, seed };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function createServer() {
  let ctx = createContext();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(INDEX_HTML).pipe(res);
      return;
    }
    if (route === 'GET /api/state') {
      sendJson(res, 200, ctx.ledger.snapshot());
      return;
    }
    if (route === 'POST /api/collect') {
      // 采集两边交接单：先展馆后运输，重复交单按 slipId 去重
      const hall = ctx.ledger.ingestBatch(ctx.seed.hallOutbox, 'hall');
      const transport = ctx.ledger.ingestBatch(ctx.seed.transportOutbox, 'transport');
      sendJson(res, 200, {
        action: 'collect',
        hall, transport,
        totals: {
          accepted: hall.accepted + transport.accepted,
          duplicates: hall.duplicates + transport.duplicates,
          rejected: hall.rejected + transport.rejected,
        },
        state: ctx.ledger.snapshot(),
      });
      return;
    }
    if (route === 'POST /api/late') {
      // 补交一条早于签收的迟到记录
      const result = ctx.ledger.ingest(ctx.seed.lateSlip);
      sendJson(res, result.status === 'rejected' ? 422 : 200, {
        action: 'late',
        result,
        state: ctx.ledger.snapshot(),
      });
      return;
    }
    if (route === 'POST /api/reset') {
      ctx = createContext();
      sendJson(res, 200, { action: 'reset', state: ctx.ledger.snapshot() });
      return;
    }
    if (route === 'GET /api/chain') {
      const id = url.searchParams.get('object') || '';
      const chain = ctx.ledger.objectChain(id);
      if (!chain) {
        sendJson(res, 404, { error: 'unknown-object', object: id });
        return;
      }
      sendJson(res, 200, { action: 'chain', ...chain });
      return;
    }
    if (route === 'GET /api/box') {
      const label = url.searchParams.get('label') || '';
      const report = ctx.ledger.boxReport(label);
      sendJson(res, report.found ? 200 : 404, { action: 'box', ...report });
      return;
    }
    sendJson(res, 404, { error: 'not-found', route });
  });

  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, '127.0.0.1', () => {
    console.log(`展品点交台账服务已启动: http://127.0.0.1:${port}`);
  });
}

module.exports = { createServer };
