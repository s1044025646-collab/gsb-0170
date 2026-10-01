import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeServices, makeEnv, VD } from './helpers.js';
import { AppError } from '../src/core/errors.js';
import { idempotent } from '../src/services/idempotency.js';

const flat3 = {
  instruments: [
    { isin: 'Z1', valuationDate: VD, cashFlows: [{ date: '2027-09-30', amount: 100 }] },
    {
      isin: 'C2',
      valuationDate: VD,
      cashFlows: [
        { date: '2027-09-30', amount: 4 },
        { date: '2028-09-30', amount: 104 }
      ]
    }
  ],
  quotes: [
    { isin: 'Z1', cleanPrice: 100 * Math.exp(-0.03), accrued: 0 },
    { isin: 'C2', cleanPrice: 4 * Math.exp(-0.03) + 104 * Math.exp(-0.06), accrued: 0 }
  ]
};

function setup(dbPath = ':memory:') {
  const svc = makeServices(dbPath);
  flat3.instruments.forEach((i) => svc.market.importInstrument(i));
  return svc;
}

test('bootstrap round trip via services reproduces quotes', () => {
  const svc = setup();
  const qv = svc.market.createQuoteVersion(VD, 'base', flat3.quotes);
  const curve = svc.curves.buildFromQuoteVersion(qv.id);
  assert.equal(curve.status, 'OK');
  for (const step of curve.steps as any[]) {
    assert.ok(Math.abs(step.error) < 1e-10);
  }
  // rebuilding same quote version is idempotent
  const again = svc.curves.buildFromQuoteVersion(qv.id);
  assert.equal(again.id, curve.id);
  svc.close();
});

test('failed bootstrap is persisted FAILED and transaction leaves no nodes', () => {
  const svc = makeServices();
  svc.market.importInstrument({
    isin: 'GAP',
    valuationDate: VD,
    cashFlows: [
      { date: '2027-03-31', amount: 5 },
      { date: '2028-09-30', amount: 105 }
    ]
  });
  const qv = svc.market.createQuoteVersion(VD, 'bad', [
    { isin: 'GAP', cleanPrice: 100, accrued: 0 }
  ]);
  assert.throws(() => svc.curves.buildFromQuoteVersion(qv.id), AppError);
  const failed = svc.curves.listCurves({}).items[0]!;
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.errorCode, 'UNSUPPORTED_DATE_STRUCTURE');
  const nodeCount = (svc.db.prepare('SELECT COUNT(*) c FROM curve_nodes').get() as { c: number }).c;
  assert.equal(nodeCount, 0);
  svc.close();
});

test('quote revision creates a new version/curve; history and report preserved', () => {
  const svc = setup();
  const v1 = svc.market.createQuoteVersion(VD, 'v1', flat3.quotes);
  const shocked = flat3.quotes.map((q) => ({ ...q, cleanPrice: q.cleanPrice * 0.99 }));
  const v2 = svc.market.createQuoteVersion(VD, 'v2-shock', shocked);
  assert.notEqual(v1.id, v2.id);
  const c1 = svc.curves.buildFromQuoteVersion(v1.id);
  const c2 = svc.curves.buildFromQuoteVersion(v2.id);
  const report = svc.reports.freezeReport(c1.id);
  assert.equal(report.quoteVersion.id, v1.id);
  assert.equal(report.quoteVersion.quotes.length, 2);
  // freezing twice returns same report
  const again = svc.reports.freezeReport(c1.id);
  assert.equal(again.id, report.id);
  // compare zero shift
  const cmp = svc.valuations.compareCurves({
    baseCurveId: c1.id,
    otherCurveId: c2.id,
    dates: ['2027-09-30']
  });
  assert.ok(cmp.points[0]!.zeroShift > 0);
  svc.close();
});

test('persistence survives restart (file-backed db)', () => {
  const path = resolve(process.cwd(), '.tmp', 'persist-test.sqlite');
  rmSync(path, { force: true });
  {
    const svc = makeServices(path, makeEnv(7));
    flat3.instruments.forEach((i) => svc.market.importInstrument(i));
    const qv = svc.market.createQuoteVersion(VD, 'base', flat3.quotes);
    svc.curves.buildFromQuoteVersion(qv.id);
    svc.close();
  }
  {
    const svc = makeServices(path, makeEnv(7));
    const versions = svc.market.listQuoteVersions({}).items;
    assert.equal(versions.length, 1);
    const curves = svc.curves.listCurves({}).items;
    assert.equal(curves.length, 1);
    assert.equal(curves[0]!.status, 'OK');
    // migrations repeat without error (already applied)
    svc.close();
  }
});

test('idempotency key replays stored response and does not run twice', () => {
  const svc = makeServices();
  let calls = 0;
  const run = () => idempotent(svc.db, 'key-123', () => (calls++, { ok: calls }));
  const first = run();
  const second = run();
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal((second.result as any).ok, 1);
  assert.equal(calls, 1);
  svc.close();
});

test('pagination enforces limit/offset and hasMore', () => {
  const svc = makeServices();
  for (let i = 0; i < 5; i++) {
    svc.market.importInstrument({
      isin: `I${i}`,
      valuationDate: VD,
      cashFlows: [{ date: '2027-09-30', amount: 100 }]
    });
  }
  const page1 = svc.market.listInstruments(VD, { limit: 2, offset: 0 });
  assert.equal(page1.items.length, 2);
  assert.equal(page1.hasMore, true);
  const page3 = svc.market.listInstruments(VD, { limit: 2, offset: 4 });
  assert.equal(page3.hasMore, false);
  svc.close();
});

test('value-bond rejects payments beyond curve horizon', () => {
  const svc = setup();
  const qv = svc.market.createQuoteVersion(VD, 'base', flat3.quotes);
  const curve = svc.curves.buildFromQuoteVersion(qv.id);
  assert.throws(
    () =>
      svc.valuations.valueBond({
        curveId: curve.id,
        cashFlows: [{ date: '2030-09-30', amount: 100 }]
      }),
    (e: Error) => e instanceof AppError && e.code === 'EXTRAPOLATION_DENIED'
  );
  svc.close();
});
