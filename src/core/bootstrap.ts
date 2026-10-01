import { BootstrapResult, CurveNode, InstrumentInput, Residual } from './types.js';
import { DiscountCurve } from './curve.js';
import { DomainError } from './errors.js';
import { parseDate, toISO, yearFraction } from './time.js';

interface PreparedInstrument {
  instrumentId: string;
  quoteVersionId: string;
  dirtyPrice: number;
  flows: { payDate: Date; amount: number }[];
  maturityDate: Date;
}

const NODE_MATCH_SECONDS = 43_200; // half-day tolerance for matching payment dates to nodes

// Bootstrap a discount curve from zero- and coupon-bearing instruments.
//
// Rules (all enforced, none silently resolved):
//  - instruments are processed in order of their final payment date;
//  - every early payment of an instrument must fall on an already solved node;
//  - the final payment establishes exactly one new node;
//  - dirty price = clean price + accrued interest; solved curves must reprice
//    every input instrument;
//  - negative rates are allowed, so discount factors are NOT required to be
//    monotonically decreasing; they must remain strictly positive;
//  - identical maturities across quotes are a conflict, never auto-selected;
//  - no extrapolation or interpolation guess is used while solving.
export function bootstrapCurve(valueDateISO: string, instruments: InstrumentInput[]): BootstrapResult {
  if (!Array.isArray(instruments) || instruments.length === 0) {
    throw new DomainError('NO_QUOTES', 'at least one quoted instrument is required to bootstrap a curve');
  }

  const valueDate = parseDate(valueDateISO);
  const prepared: PreparedInstrument[] = [];

  for (const inst of instruments) {
    if (!inst || typeof inst.instrumentId !== 'string' || inst.instrumentId.length === 0) {
      throw new DomainError('VALIDATION_ERROR', 'instrumentId is required');
    }
    if (!Array.isArray(inst.cashflows) || inst.cashflows.length === 0) {
      throw new DomainError('NO_CASHFLOWS', `instrument ${inst.instrumentId} has no cash flows`, {
        instrumentId: inst.instrumentId,
      });
    }
    if (
      typeof inst.cleanPrice !== 'number' ||
      !Number.isFinite(inst.cleanPrice) ||
      typeof inst.accruedInterest !== 'number' ||
      !Number.isFinite(inst.accruedInterest)
    ) {
      throw new DomainError('VALIDATION_ERROR', `instrument ${inst.instrumentId} has invalid price fields`, {
        instrumentId: inst.instrumentId,
      });
    }

    const flows = inst.cashflows
      .map((cf) => {
        if (typeof cf.amount !== 'number' || !Number.isFinite(cf.amount)) {
          throw new DomainError('VALIDATION_ERROR', `cash flow amount invalid for ${inst.instrumentId}`, {
            instrumentId: inst.instrumentId,
            payDate: cf.payDate,
          });
        }
        let payDate: Date;
        try {
          payDate = parseDate(cf.payDate);
        } catch {
          throw new DomainError('INVALID_DATE', `invalid cash flow date ${cf.payDate}`, {
            instrumentId: inst.instrumentId,
            payDate: cf.payDate,
          });
        }
        const t = yearFraction(valueDate, payDate);
        if (t < -1e-12) {
          throw new DomainError('PAYMENT_BEFORE_VALUE_DATE', `payment ${cf.payDate} precedes valuation date`, {
            instrumentId: inst.instrumentId,
            payDate: cf.payDate,
          });
        }
        if (Math.abs(t) <= 1e-12) {
          throw new DomainError('ZERO_TIME_CASHFLOW', `payment at valuation date is not supported: ${cf.payDate}`, {
            instrumentId: inst.instrumentId,
            payDate: cf.payDate,
          });
        }
        if (!(cf.amount > 0)) {
          throw new DomainError('VALIDATION_ERROR', `non-positive cash flow amount at ${cf.payDate}`, {
            instrumentId: inst.instrumentId,
            payDate: cf.payDate,
            amount: cf.amount,
          });
        }
        return { payDate, amount: cf.amount };
      })
      .sort((a, b) => a.payDate.getTime() - b.payDate.getTime());

    const finalFlow = flows[flows.length - 1]!;
    if (!(finalFlow.amount > 0)) {
      throw new DomainError('NON_POSITIVE_FINAL_CASHFLOW', 'final cash flow must be strictly positive', {
        instrumentId: inst.instrumentId,
        payDate: toISO(finalFlow.payDate),
        amount: finalFlow.amount,
      });
    }

    // Duplicate payment dates inside one instrument make the date structure
    // ambiguous for sequential node solving and are rejected explicitly.
    for (let i = 1; i < flows.length; i++) {
      if (flows[i]!.payDate.getTime() === flows[i - 1]!.payDate.getTime()) {
        throw new DomainError('UNSUPPORTED_DATE_STRUCTURE', `duplicate payment date inside ${inst.instrumentId}`, {
          instrumentId: inst.instrumentId,
          payDate: toISO(flows[i]!.payDate),
        });
      }
    }

    prepared.push({
      instrumentId: inst.instrumentId,
      quoteVersionId: inst.quoteVersionId,
      dirtyPrice: inst.cleanPrice + inst.accruedInterest,
      flows,
      maturityDate: finalFlow.payDate,
    });
  }

  // Same-maturity quotes conflict: there is no unique new node. We never pick
  // one quote and drop the other.
  const byMaturity = new Map<string, string[]>();
  for (const inst of prepared) {
    const key = toISO(inst.maturityDate);
    const list = byMaturity.get(key) ?? [];
    list.push(inst.instrumentId);
    byMaturity.set(key, list);
  }
  const conflicts = [...byMaturity.entries()].filter(([, ids]) => ids.length > 1);
  if (conflicts.length > 0) {
    throw new DomainError('CONFLICTING_QUOTES', 'multiple quotes resolve to the same maturity node', {
      conflicts: conflicts.map(([maturity, ids]) => ({ maturity, instrumentIds: ids })),
    });
  }

  prepared.sort((a, b) => a.maturityDate.getTime() - b.maturityDate.getTime());

  const nodes: CurveNode[] = [];

  const findNode = (date: Date): CurveNode | undefined =>
    nodes.find((n) => Math.abs(parseDate(n.payDate).getTime() - date.getTime()) <= NODE_MATCH_SECONDS * 1000);

  for (const inst of prepared) {
    const finalFlow = inst.flows[inst.flows.length - 1]!;

    if (findNode(finalFlow.payDate)) {
      // Final payment already solved by a strictly shorter instrument and the
      // quote introduces no new node: the curve would be under-determined /
      // redundant rather than uniquely bootstrapped.
      throw new DomainError(
        'UNDERDETERMINED_CURVE',
        `instrument ${inst.instrumentId} adds no new node at ${toISO(finalFlow.payDate)}`,
        { instrumentId: inst.instrumentId, maturityDate: toISO(finalFlow.payDate) },
      );
    }

    let knownPV = 0;
    for (const cf of inst.flows.slice(0, -1)) {
      const node = findNode(cf.payDate);
      if (!node) {
        throw new DomainError(
          'EARLY_PAYMENT_NOT_ON_NODE',
          `early payment ${toISO(cf.payDate)} of ${inst.instrumentId} is not on a solved node`,
          {
            instrumentId: inst.instrumentId,
            payDate: toISO(cf.payDate),
            solvedNodes: nodes.map((n) => n.payDate),
          },
        );
      }
      knownPV += cf.amount * node.discountFactor;
    }

    const dfNew = (inst.dirtyPrice - knownPV) / finalFlow.amount;
    if (!(dfNew > 0)) {
      throw new DomainError(
        'NON_POSITIVE_DISCOUNT_FACTOR',
        `solved discount factor at ${toISO(finalFlow.payDate)} is non-positive`,
        {
          instrumentId: inst.instrumentId,
          payDate: toISO(finalFlow.payDate),
          discountFactor: dfNew,
          knownPV,
          dirtyPrice: inst.dirtyPrice,
          finalAmount: finalFlow.amount,
        },
      );
    }

    const t = yearFraction(valueDate, finalFlow.payDate);
    nodes.push({
      payDate: toISO(finalFlow.payDate),
      yearFraction: t,
      discountFactor: dfNew,
      zeroRate: -Math.log(dfNew) / t,
    });
  }

  nodes.sort((a, b) => a.yearFraction - b.yearFraction);

  // Repricing check using the finished interpolated curve (identical at nodes).
  const curve = new DiscountCurve(valueDateISO, nodes);
  const residuals: Residual[] = [];
  for (const inst of prepared) {
    let modelDirtyPrice = 0;
    for (const cf of inst.flows) {
      modelDirtyPrice += cf.amount * curve.discountFactorAt(toISO(cf.payDate));
    }
    residuals.push({
      instrumentId: inst.instrumentId,
      maturityDate: toISO(inst.maturityDate),
      modelDirtyPrice,
      quotedDirtyPrice: inst.dirtyPrice,
      error: modelDirtyPrice - inst.dirtyPrice,
    });
  }

  return { nodes, residuals };
}

// Present value of a new bond's fixed cash flows on an existing curve.
// Cash flows are held fixed; only discount factors change in sensitivity work.
export function valueCashflows(
  valueDateISO: string,
  nodes: CurveNode[],
  cashflows: { payDate: string; amount: number }[],
  accruedInterest = 0,
) {
  const curve = new DiscountCurve(valueDateISO, nodes);
  const presentValues = cashflows.map((cf) => {
    const t = curve.timeFromValueDate(cf.payDate);
    const df = curve.discountFactorAt(cf.payDate);
    return {
      payDate: cf.payDate,
      yearFraction: t,
      amount: cf.amount,
      df,
      pv: cf.amount * df,
    };
  });
  const dirtyPrice = presentValues.reduce((sum, pv) => sum + pv.pv, 0);
  return {
    dirtyPrice,
    cleanPrice: dirtyPrice - accruedInterest,
    presentValues,
  };
}
