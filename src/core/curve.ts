import { AppError } from './errors.js';

export interface CurveNode {
  /** Year fraction from the valuation date (ACT/365F). */
  t: number;
  /** Discount factor df(t) = exp(-z(t) * t). May exceed 1 under negative rates. */
  df: number;
  date?: string;
}

export interface DiscountCurveData {
  valuationDate: string;
  nodes: CurveNode[];
}

export class DiscountCurve {
  readonly valuationDate: string;
  /** Nodes sorted by t ascending; t = 0, df = 1 is implicit. */
  readonly nodes: CurveNode[];

  constructor(data: DiscountCurveData) {
    this.valuationDate = data.valuationDate;
    this.nodes = [...data.nodes].sort((a, b) => a.t - b.t);
    for (const n of this.nodes) {
      if (!(n.t > 0) || !Number.isFinite(n.t)) {
        throw new AppError('VALIDATION_ERROR', `curve node time must be > 0, got ${n.t}`);
      }
      if (!(n.df > 0) || !Number.isFinite(n.df)) {
        throw new AppError('NON_POSITIVE_FACTOR', `discount factor at t=${n.t} must be > 0, got ${n.df}`);
      }
    }
  }

  /**
   * Discount factor by linear interpolation of log(df) in time:
   * log df(t) = ((t2-t)/(t2-t1))*log df1 + ((t-t1)/(t2-t1))*log df2.
   * df(0) = 1. Extrapolation beyond the last node is denied.
   */
  discountFactor(t: number): number {
    if (t === 0) return 1;
    if (t < 0) throw new AppError('EXTRAPOLATION_DENIED', `cannot discount negative time t=${t}`);
    const last = this.nodes[this.nodes.length - 1];
    if (!last) {
      throw new AppError('UNDERDETERMINED_CURVE', 'curve has no solved nodes');
    }
    if (t > last.t + 1e-12) {
      throw new AppError(
        'EXTRAPOLATION_DENIED',
        `t=${t} lies beyond last curve node t=${last.t}; extrapolation is not allowed`
      );
    }
    let lo: { t: number; df: number } = { t: 0, df: 1 };
    let hi: CurveNode | undefined;
    for (const n of this.nodes) {
      if (Math.abs(n.t - t) <= 1e-12) return n.df;
      if (n.t < t) lo = n;
      else if (n.t > t) {
        hi = n;
        break;
      }
    }
    if (!hi) return lo.df;
    const w = (t - lo.t) / (hi.t - lo.t);
    return Math.exp((1 - w) * Math.log(lo.df) + w * Math.log(hi.df));
  }

  /** Continuously compounded zero-coupon rate z(t) = -log(df(t)) / t (annualised). */
  zeroRate(t: number): number {
    if (!(t > 0)) throw new AppError('VALIDATION_ERROR', 'zero rate requires t > 0');
    return -Math.log(this.discountFactor(t)) / t;
  }

  /**
   * Annualised continuously-compounded interval forward rate f(t1,t2):
   * f = (log df(t1) - log df(t2)) / (t2 - t1).
   * An interval average: distinct from the point zero rate and from a bond
   * yield-to-maturity.
   */
  forwardRate(t1: number, t2: number): number {
    if (!(t2 > t1)) {
      throw new AppError('VALIDATION_ERROR', `forward interval requires t1 < t2, got ${t1}, ${t2}`);
    }
    const df1 = this.discountFactor(t1);
    const df2 = this.discountFactor(t2);
    return (Math.log(df1) - Math.log(df2)) / (t2 - t1);
  }

  /** Zero rate at every node plus the interval forward rate between adjacent nodes. */
  describe() {
    const zeros = this.nodes.map((n) => ({
      t: n.t,
      date: n.date,
      df: n.df,
      zero: -Math.log(n.df) / n.t
    }));
    const forwards: { t1: number; t2: number; forward: number }[] = [];
    let prev: { t: number; df: number } = { t: 0, df: 1 };
    for (const n of this.nodes) {
      forwards.push({
        t1: prev.t,
        t2: n.t,
        forward: (Math.log(prev.df) - Math.log(n.df)) / (n.t - prev.t)
      });
      prev = n;
    }
    return { valuationDate: this.valuationDate, zeros, forwards };
  }
}
