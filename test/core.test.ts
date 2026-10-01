import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiscountCurve } from '../src/core/curve.js';
import { bootstrap } from '../src/core/bootstrap.js';
import { prepareInstrument } from '../src/core/instrument.js';
import { DiscountCurve as DC } from '../src/core/curve.js';
import { computeDv01, DV01_SHIFT } from '../src/core/dv01.js';
import { presentValue } from '../src/core/pricing.js';
import { AppError } from '../src/core/errors.js';

const VD = '2026-09-30';

function inst(isin: string, flows: [string, number][]) {
  return prepareInstrument({ isin, valuationDate: VD, cashFlows: flows.map(([date, amount]) => ({ date, amount })) });
}

test('flat curve: two/three node hand check reproduces dirty prices', () => {
  // Flat 3% continuous curve, annual nodes.
  const df1 = Math.exp(-0.03);
  const df2 = Math.exp(-0.06);
  const df3 = Math.exp(-0.09);
  const zero = inst('ZERO1', [['2027-09-30', 100]]);
  const cpn2 = inst('CPN2', [
    ['2027-09-30', 4],
    ['2028-09-30', 104]
  ]);
  const cpn3 = inst('CPN3', [
    ['2027-09-30', 5],
    ['2028-09-30', 5],
    ['2029-09-30', 105]
  ]);
  const p0 = 100 * df1;
  const p1 = 4 * df1 + 104 * df2;
  const p2 = 5 * df1 + 5 * df2 + 105 * df3;
  const result = bootstrap({
    valuationDate: VD,
    instruments: [zero, cpn2, cpn3],
    quotes: [
      { isin: 'ZERO1', cleanPrice: p0, accrued: 0 },
      { isin: 'CPN2', cleanPrice: p1, accrued: 0 },
      { isin: 'CPN3', cleanPrice: p2 - 1.25, accrued: 1.25 } // non-zero accrued
    ]
  });
  assert.ok(result.nodes.every((n) => n.df > 0));
  assert.ok(Math.abs(result.nodes[0]!.df - df1) < 1e-12);
  assert.ok(Math.abs(result.nodes[1]!.df - df2) < 1e-12);
  assert.ok(Math.abs(result.nodes[2]!.df - df3) < 1e-12);
  for (const s of result.steps) assert.ok(Math.abs(s.error) < 1e-10, `repricing error ${s.error}`);
});

test('negative rates yield df > 1 without forced monotonic decline', () => {
  // Flat -1% curve: df(t) = exp(+0.01 t) > 1 and INCREASING.
  const df1 = Math.exp(0.01);
  const df2 = Math.exp(0.02);
  const result = bootstrap({
    valuationDate: VD,
    instruments: [
      inst('N1', [['2027-09-30', 100]]),
      inst('N2', [['2027-09-30', 2], ['2028-09-30', 102]])
    ],
    quotes: [
      { isin: 'N1', cleanPrice: 100 * df1, accrued: 0 },
      { isin: 'N2', cleanPrice: 2 * df1 + 102 * df2, accrued: 0 }
    ]
  });
  assert.ok(result.nodes[0]!.df > 1);
  assert.ok(result.nodes[1]!.df > result.nodes[0]!.df);
  const curve = new DiscountCurve({ valuationDate: VD, nodes: result.nodes });
  assert.ok(curve.zeroRate(result.nodes[1]!.t) < 0);
});

test('missing node: early payment not on solved node is rejected', () => {
  assert.throws(
    () =>
      bootstrap({
        valuationDate: VD,
        instruments: [
          inst('Z', [['2027-09-30', 100]]),
          inst('X', [['2028-03-31', 5], ['2028-09-30', 105]]) // first node is 2027-09-30
        ],
        quotes: [
          { isin: 'Z', cleanPrice: 97, accrued: 0 },
          { isin: 'X', cleanPrice: 102, accrued: 0 }
        ]
      }),
    (err: Error) => err instanceof AppError && err.code === 'UNSUPPORTED_DATE_STRUCTURE'
  );
});

test('conflicting quotes at same maturity are both reported, never auto-picked', () => {
  try {
    bootstrap({
      valuationDate: VD,
      instruments: [
        inst('A', [['2027-09-30', 100]]),
        inst('B', [['2027-09-30', 100]])
      ],
      quotes: [
        { isin: 'A', cleanPrice: 97, accrued: 0 },
        { isin: 'B', cleanPrice: 98, accrued: 0 }
      ]
    });
    assert.fail('expected MATURITY_CONFLICT');
  } catch (err) {
    assert.ok(err instanceof AppError);
    assert.equal(err.code, 'MATURITY_CONFLICT');
    const details = err.details as { conflicting: { isin: string }[] };
    assert.deepEqual(details.conflicting.map((c) => c.isin).sort(), ['A', 'B']);
  }
});

test('non-positive final cash flow and non-positive factor are rejected', () => {
  assert.throws(
    () => inst('BAD', [['2027-09-30', 0]]),
    (e: Error) => e instanceof AppError && e.code === 'NON_POSITIVE_FINAL_CASHFLOW'
  );
  assert.throws(
    () =>
      bootstrap({
        valuationDate: VD,
        instruments: [inst('P', [['2027-09-30', 100]])],
        quotes: [{ isin: 'P', cleanPrice: -5, accrued: 0 }]
      }),
    (e: Error) => e instanceof AppError && e.code === 'NON_POSITIVE_FACTOR'
  );
});

test('empty instrument set is underdetermined', () => {
  assert.throws(
    () => bootstrap({ valuationDate: VD, instruments: [], quotes: [] }),
    (e: Error) => e instanceof AppError && e.code === 'UNDERDETERMINED_CURVE'
  );
});

test('log-df interpolation is continuous and exactly linear in log space', () => {
  const curve = new DC({
    valuationDate: VD,
    nodes: [
      { t: 1, df: Math.exp(-0.03), date: '2027-09-30' },
      { t: 2, df: Math.exp(-0.07), date: '2028-09-30' }
    ]
  });
  const t = 1.37;
  const expected = Math.exp(-0.03 * (2 - t) - 0.07 * (t - 1));
  assert.ok(Math.abs(curve.discountFactor(t) - expected) < 1e-14);
  // continuity at node boundaries
  assert.equal(curve.discountFactor(1), Math.exp(-0.03));
  assert.equal(curve.discountFactor(2), Math.exp(-0.07));
});

test('extrapolation beyond last node is denied', () => {
  const curve = new DC({ valuationDate: VD, nodes: [{ t: 1, df: 0.97 }] });
  assert.throws(() => curve.discountFactor(1.5), (e: Error) => e instanceof AppError && e.code === 'EXTRAPOLATION_DENIED');
});

test('present value is linear in cash-flow amounts', () => {
  const curve = new DC({
    valuationDate: VD,
    nodes: [
      { t: 1, df: 0.97, date: '2027-09-30' },
      { t: 2, df: 0.94, date: '2028-09-30' }
    ]
  });
  const a = [{ date: '2027-09-30', amount: 3, t: 1 }];
  const b = [{ date: '2028-09-30', amount: 7, t: 2 }];
  const pvA = presentValue(curve, a);
  const pvB = presentValue(curve, b);
  const pvAb = presentValue(curve, [
    { date: '2027-09-30', amount: 6, t: 1 },
    { date: '2028-09-30', amount: 14, t: 2 }
  ]);
  assert.ok(Math.abs(pvAb - 2 * (pvA + pvB)) < 1e-12);
});

test('DV01 finite differences converge to analytical duration slope as h shrinks', () => {
  // Flat curve r: PV under bump h changes by exp(-h t); derivative wrt h at 0 = -t-weighted PV.
  const r = 0.03;
  const data = {
    valuationDate: VD,
    nodes: [
      { t: 1, df: Math.exp(-r), date: '2027-09-30' },
      { t: 2, df: Math.exp(-2 * r), date: '2028-09-30' }
    ]
  };
  const flows = [
    { date: '2027-09-30', amount: 4, t: 1 },
    { date: '2028-09-30', amount: 104, t: 2 }
  ];
  const base = presentValue(new DC(data), flows);
  const analytical = (1 * 4 * Math.exp(-r) + 2 * 104 * Math.exp(-2 * r)); // -dPV/dh at h=0
  let prevErr = Infinity;
  for (const h of [0.01, 0.001, 0.0001, 0.00001]) {
    const r1 = computeDv01(data, flows, h);
    const centralRate = r1.dv01Central / h; // -(PV+ - PV-)/(2h)
    const err = Math.abs(centralRate - analytical);
    assert.ok(err < prevErr + 1e-9, `central difference should converge, err=${err}`);
    prevErr = err;
  }
  // At 1bp the DV01 is ~ slope * 1bp and cash flows are unchanged.
  const bump = computeDv01(data, flows, DV01_SHIFT);
  assert.equal(bump.cashFlowsHeldFixed, true);
  assert.ok(Math.abs(bump.dv01OneSided - analytical * DV01_SHIFT) < 1e-4);
  void base;
});
