import { MarketDataService } from '../services/market-service.js';

/**
 * FICTIONAL instruments and quotes, purely for teaching.
 * Valuation date 2026-09-30. Annual fixed payments that line up with yearly
 * nodes so the bootstrapper can solve one node per instrument in order.
 */
export const VALUATION_DATE = '2026-09-30';

export interface Scenario {
  label: string;
  instruments: {
    isin: string;
    valuationDate: string;
    cashFlows: { date: string; amount: number }[];
  }[];
  versions: { label: string; quotes: { isin: string; cleanPrice: number; accrued: number }[] }[];
}

export const SEED_SCENARIO: Scenario = {
  label: 'fictional-teaching-set',
  instruments: [
    {
      // 1y zero, flat 3% curve => clean = 100 * exp(-0.03)
      isin: 'ZERO001',
      valuationDate: VALUATION_DATE,
      cashFlows: [{ date: '2027-09-30', amount: 100 }]
    },
    {
      // 2y 4% annual coupon, par-ish under a mildly upward curve
      isin: 'CPN0002',
      valuationDate: VALUATION_DATE,
      cashFlows: [
        { date: '2027-09-30', amount: 4 },
        { date: '2028-09-30', amount: 104 }
      ]
    },
    {
      // 3y 5% annual coupon with non-zero accrued at valuation (settles mid-period)
      isin: 'CPN0003',
      valuationDate: VALUATION_DATE,
      cashFlows: [
        { date: '2027-09-30', amount: 5 },
        { date: '2028-09-30', amount: 5 },
        { date: '2029-09-30', amount: 105 }
      ]
    }
  ],
  versions: [
    {
      label: 'v1-base',
      quotes: [
        // flat 3% continuous zero
        { isin: 'ZERO001', cleanPrice: 97.04455335485082, accrued: 0 },
        // prices generated FROM exp(-0.03 t), 4% and 5% coupons
        { isin: 'CPN0002', cleanPrice: 4 * Math.exp(-0.03) + 104 * Math.exp(-0.06), accrued: 0 },
        {
          // non-zero accrued: clean = theoretical dirty - accrued, so the curve
          // still reprices the input DIRTY price exactly.
          isin: 'CPN0003',
          cleanPrice: 5 * Math.exp(-0.03) + 5 * Math.exp(-0.06) + 105 * Math.exp(-0.09) - 1.25,
          accrued: 1.25
        }
      ]
    },
    {
      // revision: +50bp parallel, never overwrites v1
      label: 'v2-shock-plus50bp',
      quotes: [
        { isin: 'ZERO001', cleanPrice: 100 * Math.exp(-0.035), accrued: 0 },
        { isin: 'CPN0002', cleanPrice: 4 * Math.exp(-0.035) + 104 * Math.exp(-0.07), accrued: 0 },
        { isin: 'CPN0003', cleanPrice: 5 * Math.exp(-0.035) + 5 * Math.exp(-0.07) + 105 * Math.exp(-0.105) - 1.25, accrued: 1.25 }
      ]
    }
  ]
};

export function seedScenario(service: MarketDataService): {
  valuationDate: string;
  versionIds: string[];
} {
  for (const inst of SEED_SCENARIO.instruments) {
    service.importInstrument(inst);
  }
  const versionIds: string[] = [];
  for (const v of SEED_SCENARIO.versions) {
    const created = service.createQuoteVersion(VALUATION_DATE, v.label, v.quotes);
    versionIds.push(created.id);
  }
  return { valuationDate: VALUATION_DATE, versionIds };
}
