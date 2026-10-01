import type { CurveNode } from './types.js';
import { valueCashflows } from './bootstrap.js';

export const DV01_BUMP_RATE = 0.0001; // 1 basis point in continuously-compounded rate terms

// Apply a parallel shift to the zero-rate curve. Since df(t)=exp(-z*t),
// shifting z by delta shifts log df by -delta*t. Cash flows are untouched:
// sensitivity comes purely from discounting, never from changing principals.
export function shiftZeroCurve(nodes: CurveNode[], delta: number): CurveNode[] {
  return nodes.map((n) => {
    const df = n.discountFactor * Math.exp(-delta * n.yearFraction);
    return {
      payDate: n.payDate,
      yearFraction: n.yearFraction,
      discountFactor: df,
      zeroRate: n.zeroRate + delta,
    };
  });
}

export interface DV01Result {
  dirtyPriceBase: number;
  dirtyPriceUp: number;
  dirtyPriceDown: number;
  dv01: number; // -(P(+1bp) - P(-1bp)) / 2, positive for a long bond position
  bumpedPriceUp: number;
  bumpedPriceDown: number;
  convention: {
    bumpType: 'parallel_zero_rate_shift';
    bumpSize: number;
    compounding: 'continuous';
    dayCount: 'ACT/365F';
    cashflowsHeldFixed: true;
    differenceScheme: 'central';
  };
}

export function computeDV01(
  valueDateISO: string,
  nodes: CurveNode[],
  cashflows: { payDate: string; amount: number }[],
  accruedInterest = 0,
  bump = DV01_BUMP_RATE,
): DV01Result {
  const base = valueCashflows(valueDateISO, nodes, cashflows, accruedInterest).dirtyPrice;
  const up = valueCashflows(valueDateISO, shiftZeroCurve(nodes, bump), cashflows, accruedInterest).dirtyPrice;
  const down = valueCashflows(valueDateISO, shiftZeroCurve(nodes, -bump), cashflows, accruedInterest).dirtyPrice;
  return {
    dirtyPriceBase: base,
    dirtyPriceUp: up,
    dirtyPriceDown: down,
    dv01: -(up - down) / 2,
    bumpedPriceUp: up,
    bumpedPriceDown: down,
    convention: {
      bumpType: 'parallel_zero_rate_shift',
      bumpSize: bump,
      compounding: 'continuous',
      dayCount: 'ACT/365F',
      cashflowsHeldFixed: true,
      differenceScheme: 'central',
    },
  };
}
