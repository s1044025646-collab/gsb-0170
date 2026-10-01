import { AppError } from './errors.js';
import { DiscountCurve, CurveNode } from './curve.js';
import { PreparedInstrument } from './instrument.js';
import { presentValue } from './pricing.js';

export interface BootstrapQuote {
  isin: string;
  cleanPrice: number;
  accrued: number;
}

export interface BootstrapInput {
  valuationDate: string;
  instruments: PreparedInstrument[];
  quotes: BootstrapQuote[];
}

export interface BootstrapStep {
  isin: string;
  maturityDate: string;
  t: number;
  dirtyPrice: number;
  pvOfKnownFlows: number;
  finalAmount: number;
  df: number;
  repricedDirty: number;
  error: number;
}

export interface BootstrapResult {
  valuationDate: string;
  nodes: CurveNode[];
  steps: BootstrapStep[];
}

const NODE_TOL = 1e-10;

/**
 * Bootstrap discount factors from zero and coupon-bearing instruments.
 *
 * Contract:
 *  - instruments are solved in maturity order;
 *  - every payment before an instrument's maturity must land on an already
 *    solved node (exact date match); the final payment creates one new node;
 *  - two quotes sharing a maturity are a conflict and are both reported,
 *    never silently deduped;
 *  - a non-positive solved factor is reported;
 *  - an empty instrument set is an underdetermined curve.
 *
 * Negative rates are legal and produce df > 1; no monotonicity is imposed.
 */
export function bootstrap(input: BootstrapInput): BootstrapResult {
  if (input.instruments.length === 0) {
    throw new AppError('UNDERDETERMINED_CURVE', 'no instruments supplied; curve has zero nodes');
  }

  const quoteByIsin = new Map<string, BootstrapQuote>();
  for (const q of input.quotes) {
    if (typeof q.cleanPrice !== 'number' || !Number.isFinite(q.cleanPrice)) {
      throw new AppError('VALIDATION_ERROR', `quote for ${q.isin} has non-finite clean price`);
    }
    if (quoteByIsin.has(q.isin)) {
      throw new AppError('VALIDATION_ERROR', `duplicate quote for ${q.isin} in same quote set`);
    }
    quoteByIsin.set(q.isin, q);
  }

  const ordered = [...input.instruments].sort((a, b) => a.maturity.t - b.maturity.t);

  // Detect same-maturity conflicts up front: report BOTH (or all) quotes.
  const byMaturity = new Map<string, PreparedInstrument[]>();
  for (const inst of ordered) {
    const key = inst.maturity.date;
    const list = byMaturity.get(key) ?? [];
    list.push(inst);
    byMaturity.set(key, list);
  }
  for (const [date, list] of byMaturity) {
    if (list.length > 1) {
      const conflicting = list.map((inst) => {
        const q = quoteByIsin.get(inst.isin);
        return {
          isin: inst.isin,
          maturityDate: date,
          cleanPrice: q?.cleanPrice ?? null,
          accrued: q?.accrued ?? null
        };
      });
      throw new AppError(
        'MATURITY_CONFLICT',
        `${list.length} instruments mature on ${date} with competing quotes; refusing to pick one`,
        { maturityDate: date, conflicting }
      );
    }
  }

  const nodes: CurveNode[] = [];
  const steps: BootstrapStep[] = [];

  for (const inst of ordered) {
    const quote = quoteByIsin.get(inst.isin);
    if (!quote) {
      throw new AppError('VALIDATION_ERROR', `missing quote for instrument ${inst.isin}`);
    }
    if (inst.valuationDate !== input.valuationDate) {
      throw new AppError(
        'VALIDATION_ERROR',
        `instrument ${inst.isin} valuation date ${inst.valuationDate} != curve valuation date ${input.valuationDate}`
      );
    }

    // Every early payment must coincide with a previously solved node.
    for (const cf of inst.early) {
      const hit = nodes.some((n) => Math.abs(n.t - cf.t) <= NODE_TOL);
      if (!hit) {
        throw new AppError(
          'UNSUPPORTED_DATE_STRUCTURE',
          `payment of ${inst.isin} at ${cf.date} (t=${cf.t}) does not land on a solved node; ` +
            `solved node dates: [${nodes.map((n) => n.date ?? n.t.toFixed(6)).join(', ')}]`
        );
      }
    }

    const duplicateNode = nodes.some((n) => Math.abs(n.t - inst.maturity.t) <= NODE_TOL);
    if (duplicateNode) {
      throw new AppError('MATURITY_CONFLICT', `maturity ${inst.maturity.date} already solved`);
    }

    const partialCurve = new DiscountCurve({ valuationDate: input.valuationDate, nodes });
    const knownPv = presentValue(partialCurve, inst.early);
    const dirty = quote.cleanPrice + quote.accrued;
    const df = (dirty - knownPv) / inst.maturity.amount;

    if (!(df > 0) || !Number.isFinite(df)) {
      throw new AppError(
        'NON_POSITIVE_FACTOR',
        `solved discount factor for ${inst.isin} at ${inst.maturity.date} is ${df}; ` +
          `dirty price ${dirty} minus PV(known flows) ${knownPv} must be positive`,
        { isin: inst.isin, maturityDate: inst.maturity.date, df, dirtyPrice: dirty, knownPv }
      );
    }

    nodes.push({ t: inst.maturity.t, df, date: inst.maturity.date });
    const extended = new DiscountCurve({ valuationDate: input.valuationDate, nodes });
    const repriced = presentValue(extended, inst.cashFlows);
    steps.push({
      isin: inst.isin,
      maturityDate: inst.maturity.date,
      t: inst.maturity.t,
      dirtyPrice: dirty,
      pvOfKnownFlows: knownPv,
      finalAmount: inst.maturity.amount,
      df,
      repricedDirty: repriced,
      error: repriced - dirty
    });
  }

  return { valuationDate: input.valuationDate, nodes, steps };
}
