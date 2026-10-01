import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, listenLocalhost } from '../src/api/server.js';
import { makeServices, VD } from './helpers.js';
import { Server } from 'node:http';

async function api(base: string, method: string, path: string, body?: unknown, idemKey?: string) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(idemKey ? { 'idempotency-key': idemKey } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json();
  return { status: res.status, json };
}

test('HTTP API: validation codes, idempotency, pagination and full workflow', async () => {
  const svc = makeServices();
  const app: Server = createApp(svc);
  const { port, close } = await listenLocalhost(app, 0);
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await api(base, 'GET', '/api/health')).json.status, 'ok');

    const bad = await api(base, 'POST', '/api/instruments', { isin: 'X' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'VALIDATION_ERROR');

    const notFound = await api(base, 'GET', '/api/curves/nope');
    assert.equal(notFound.status, 404);
    assert.equal(notFound.json.error.code, 'NOT_FOUND');

    const inst = {
      isin: 'Z1',
      valuationDate: VD,
      cashFlows: [{ date: '2027-09-30', amount: 100 }]
    };
    const first = await api(base, 'POST', '/api/instruments', inst, 'demo-key-1');
    assert.equal(first.status, 200);
    const replay = await api(base, 'POST', '/api/instruments', inst, 'demo-key-1');
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.json, first.json);

    const qvBody = {
      valuationDate: VD,
      label: 'base',
      quotes: [{ isin: 'Z1', cleanPrice: 100 * Math.exp(-0.03), accrued: 0 }]
    };
    const qv = await api(base, 'POST', '/api/quote-versions', qvBody);
    assert.equal(qv.status, 200);

    const built = await api(base, 'POST', '/api/curves/build', { quoteVersionId: qv.json.id });
    assert.equal(built.json.status, 'OK');
    assert.ok(Math.abs(built.json.nodes[0].df - Math.exp(-0.03)) < 1e-12);

    const list = await api(base, 'GET', '/api/curves?limit=1&offset=0');
    assert.equal(list.json.limit, 1);
    assert.equal(list.json.items.length, 1);

    const valued = await api(base, 'POST', '/api/valuations', {
      curveId: built.json.id,
      cashFlows: [{ date: '2027-09-30', amount: 10 }]
    });
    assert.ok(Math.abs(valued.json.pv - 10 * Math.exp(-0.03)) < 1e-10);
    assert.ok(typeof valued.json.dv01.dv01Central === 'number');

    const frozen = await api(base, 'POST', '/api/reports/freeze', { curveId: built.json.id });
    assert.equal(frozen.json.quoteVersion.quotes[0].isin, 'Z1');
  } finally {
    await close();
    svc.close();
  }
});
