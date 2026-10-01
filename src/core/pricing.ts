import { DiscountCurve } from './curve.js';
import { ScheduledCashFlow } from './instrument.js';

/** Present value of a fixed cash-flow stream on a given curve. Linear in cash flows. */
export function presentValue(curve: DiscountCurve, cashFlows: ScheduledCashFlow[]): number {
  let pv = 0;
  for (const cf of cashFlows) {
    pv += cf.amount * curve.discountFactor(cf.t);
  }
  return pv;
}

export interface RepricingDetail {
  date: string;
  t: number;
  amount: number;
  df: number;
  pv: number;
}

export function reprice(curve: DiscountCurve, cashFlows: ScheduledCashFlow[]): { pv: number; details: RepricingDetail[] } {
  const details: RepricingDetail[] = cashFlows.map((cf) => {
    const df = curve.discountFactor(cf.t);
    return { date: cf.date, t: cf.t, amount: cf.amount, df, pv: cf.amount * df };
  });
  return { pv: details.reduce((s, d) => s + d.pv, 0), details };
}
