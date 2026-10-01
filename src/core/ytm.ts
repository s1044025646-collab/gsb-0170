import { AppError } from './errors.js';
import { ScheduledCashFlow } from './instrument.js';

/**
 * Continuously-compounded yield-to-maturity for ONE bond:
 *   price = sum_i amount_i * exp(-y * t_i)
 * solved by bisection. This is a bond-level IRR and must not be confused
 * with the curve zero rate or an interval forward rate.
 */
export function yieldToMaturity(cashFlows: ScheduledCashFlow[], dirtyPrice: number): number {
  if (!(dirtyPrice > 0)) {
    throw new AppError('VALIDATION_ERROR', `YTM requires positive dirty price, got ${dirtyPrice}`);
  }
  if (cashFlows.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'YTM requires at least one cash flow');
  }
  let lo = -5;
  let hi = 5;
  const npv = (y: number) => cashFlows.reduce((s, cf) => s + cf.amount * Math.exp(-y * cf.t), 0);
  let fLo = npv(lo) - dirtyPrice;
  let fHi = npv(hi) - dirtyPrice;
  let guard = 0;
  while (fLo * fHi > 0 && guard < 20) {
    lo *= 2;
    hi *= 2;
    fLo = npv(lo) - dirtyPrice;
    fHi = npv(hi) - dirtyPrice;
    guard++;
  }
  if (fLo * fHi > 0) {
    throw new AppError('CONFLICT', 'YTM bisection bracket failed; check cash flow signs');
  }
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid) - dirtyPrice;
    if (Math.abs(fMid) < 1e-12) return mid;
    if (fLo * fMid <= 0) {
      hi = mid;
      fHi = fMid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return (lo + hi) / 2;
}
