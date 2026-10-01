import { DiscountCurve, DiscountCurveData } from './curve.js';
import { ScheduledCashFlow } from './instrument.js';
import { presentValue } from './pricing.js';

export const DV01_SHIFT = 0.0001; // 1 basis point in annualised rate terms

export interface ShiftedCurveOptions {
  /** Parallel rate shift in decimal, e.g. 0.0001 = +1bp. */
  shift: number;
}

/**
 * Apply a PARALLEL shift to the continuously-compounded zero curve while the
 * cash-flow schedule is held fixed (same dates and amounts). The shift changes
 * discount factors only: df'(t) = df(t) * exp(-shift * t). Principal never
 * changes, so the price move is purely a rate effect.
 */
export function shiftCurve(data: DiscountCurveData, shift: number): DiscountCurve {
  const nodes = data.nodes.map((n) => ({
    t: n.t,
    date: n.date,
    df: n.df * Math.exp(-shift * n.t)
  }));
  return new DiscountCurve({ valuationDate: data.valuationDate, nodes });
}

export interface Dv01Result {
  basePv: number;
  upPv: number;
  downPv: number;
  /** One-sided finite difference, -(PV(+1bp) - PV(0)) / 1bp: value gain per +1bp... reported as price DECLINE. */
  dv01OneSided: number;
  /** Central difference -(PV(+h) - PV(-h)) / (2h), h = 1bp. */
  dv01Central: number;
  shift: number;
  perturbation: 'PARALLEL_ZERO_RATE_SHIFT_BP';
  cashFlowsHeldFixed: true;
}

/**
 * DV01 of a fixed cash-flow stream under a parallel zero-rate bump.
 * Sign convention: DV01 = -(PV_up - PV_base), i.e. the price change in price
 * units for a +1bp move (negative for a long bond position is NOT forced;
 * both numbers are reported so the convention is explicit).
 */
export function computeDv01(
  curveData: DiscountCurveData,
  cashFlows: ScheduledCashFlow[],
  shift: number = DV01_SHIFT
): Dv01Result {
  const base = new DiscountCurve(curveData);
  const up = shiftCurve(curveData, shift);
  const down = shiftCurve(curveData, -shift);
  const basePv = presentValue(base, cashFlows);
  const upPv = presentValue(up, cashFlows);
  const downPv = presentValue(down, cashFlows);
  return {
    basePv,
    upPv,
    downPv,
    dv01OneSided: basePv - upPv,
    dv01Central: (downPv - upPv) / 2,
    shift,
    perturbation: 'PARALLEL_ZERO_RATE_SHIFT_BP',
    cashFlowsHeldFixed: true
  };
}
