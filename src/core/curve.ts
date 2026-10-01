import { DomainError } from './errors.js';
import { parseDate, yearFraction } from './time.js';
import type { CurveNode } from './types.js';

export const NODE_TOL_DAYS = 0;

// Piecewise-linear interpolation of log discount factor between nodes.
// Negative rates are allowed: discount factors need not decrease monotonically.
// Extrapolation outside the solved range is always rejected.
export class DiscountCurve {
  private readonly valueDate: Date;
  private readonly nodes: CurveNode[];

  constructor(valueDate: string, nodes: CurveNode[]) {
    this.valueDate = parseDate(valueDate);
    if (nodes.length === 0) {
      throw new DomainError('UNDERDETERMINED_CURVE', 'curve has no nodes');
    }
    const sorted = [...nodes].sort((a, b) => a.yearFraction - b.yearFraction);
    for (const node of sorted) {
      if (!(node.discountFactor > 0)) {
        throw new DomainError(
          'NON_POSITIVE_DISCOUNT_FACTOR',
          `non-positive discount factor at ${node.payDate}`,
          { payDate: node.payDate, discountFactor: node.discountFactor },
        );
      }
    }
    this.nodes = sorted;
  }

  get valueDateISO(): string {
    return this.nodes.length ? this.valueDate.toISOString().slice(0, 10) : '';
  }

  getNodes(): CurveNode[] {
    return this.nodes.map((n) => ({ ...n }));
  }

  timeFromValueDate(payDate: string): number {
    return yearFraction(this.valueDate, parseDate(payDate));
  }

  discountFactorAt(payDate: string): number {
    const t = this.timeFromValueDate(payDate);
    return this.discountFactorAtT(t, payDate);
  }

  discountFactorAtT(t: number, payDateForError?: string): number {
    if (t < -1e-12) {
      throw new DomainError(
        'PAYMENT_BEFORE_VALUE_DATE',
        `payment ${payDateForError ?? ''} is before the valuation date`,
        { payDate: payDateForError, t },
      );
    }
    const first = this.nodes[0]!;
    const last = this.nodes[this.nodes.length - 1]!;
    if (t < first.yearFraction - 1e-12 || t > last.yearFraction + 1e-12) {
      throw new DomainError(
        'EXTRAPOLATION_REJECTED',
        `time ${t.toFixed(6)} is outside solved node range [${first.yearFraction}, ${last.yearFraction}]`,
        { t, firstT: first.yearFraction, lastT: last.yearFraction, payDate: payDateForError },
      );
    }
    if (t <= first.yearFraction + 1e-12) return first.discountFactor;
    if (t >= last.yearFraction - 1e-12) return last.discountFactor;

    for (let i = 0; i < this.nodes.length - 1; i++) {
      const left = this.nodes[i]!;
      const right = this.nodes[i + 1]!;
      if (t >= left.yearFraction && t <= right.yearFraction) {
        const w = (t - left.yearFraction) / (right.yearFraction - left.yearFraction);
        const logDf = (1 - w) * Math.log(left.discountFactor) + w * Math.log(right.discountFactor);
        return Math.exp(logDf);
      }
    }
    // Unreachable given range checks above.
    throw new DomainError('EXTRAPOLATION_REJECTED', 'interpolation failed', { t });
  }

  hasNodeAt(payDate: string): boolean {
    const t = this.timeFromValueDate(payDate);
    return this.nodes.some((n) => Math.abs(n.yearFraction - t) <= 0.5 / 365 + 1e-12);
  }

  // Continuously compounded zero-coupon rate z(t): df(t) = exp(-z*t).
  zeroRateAt(payDate: string): number {
    const t = this.timeFromValueDate(payDate);
    const df = this.discountFactorAtT(t, payDate);
    if (Math.abs(t) < 1e-12) {
      throw new DomainError('VALIDATION_ERROR', 'zero rate at t=0 is undefined', { payDate });
    }
    return -Math.log(df) / t;
  }

  // Simple (period) continuously-compounded forward rate between two dates:
  // df(t1) / df(t2) = exp(f * (t2 - t1))  =>  f = (ln df(t1) - ln df(t2)) / (t2 - t1)
  forwardRate(startDate: string, endDate: string): number {
    const t1 = this.timeFromValueDate(startDate);
    const t2 = this.timeFromValueDate(endDate);
    if (!(t2 > t1 + 1e-12)) {
      throw new DomainError('VALIDATION_ERROR', 'forward end date must be strictly after start date', {
        startDate,
        endDate,
      });
    }
    const df1 = this.discountFactorAtT(t1, startDate);
    const df2 = this.discountFactorAtT(t2, endDate);
    return (Math.log(df1) - Math.log(df2)) / (t2 - t1);
  }
}

// Continuously compounded yield-to-maturity for a fixed set of cash flows:
// dirtyPrice = sum amount_i * exp(-y * t_i). Solved by bisection (globally
// robust for amounts > 0); negative yields are allowed.
export function yieldToMaturity(
  valueDate: string,
  cashflows: { payDate: string; amount: number }[],
  dirtyPrice: number,
): number {
  const vd = parseDate(valueDate);
  const flows = cashflows
    .map((cf) => ({ t: yearFraction(vd, parseDate(cf.payDate)), amount: cf.amount }))
    .filter((cf) => cf.t > 1e-12)
    .sort((a, b) => a.t - b.t);
  if (flows.length === 0) {
    throw new DomainError('NO_CASHFLOWS', 'cannot compute YTM without future cash flows');
  }
  if (!(dirtyPrice > 0)) {
    throw new DomainError('VALIDATION_ERROR', 'YTM requires a positive dirty price', { dirtyPrice });
  }
  const price = (y: number) => flows.reduce((sum, cf) => sum + cf.amount * Math.exp(-y * cf.t), 0);
  let lo = -2;
  let hi = 2;
  // Widen brackets until the price brackets the target (monotone in y).
  for (let i = 0; i < 60; i++) {
    const pLo = price(lo);
    const pHi = price(hi);
    if (pLo >= dirtyPrice && pHi <= dirtyPrice) break;
    if (pLo < dirtyPrice) lo -= 2;
    if (pHi > dirtyPrice) hi += 2;
  }
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const pMid = price(mid);
    if (Math.abs(pMid - dirtyPrice) < 1e-12) return mid;
    if (pMid > dirtyPrice) lo = mid;
    else hi = mid;
  }
  const y = (lo + hi) / 2;
  if (Math.abs(price(y) - dirtyPrice) > 1e-8) {
    throw new DomainError('YTM_NO_CONVERGENCE', 'YTM bisection did not converge', {
      residual: price(y) - dirtyPrice,
    });
  }
  return y;
}
