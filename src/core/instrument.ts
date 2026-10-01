import { AppError } from './errors.js';
import { parseIsoDate, toIso, yearFraction } from './dates.js';

export interface CashFlowInput {
  date: string;
  amount: number;
}

export interface ScheduledCashFlow {
  date: string;
  amount: number;
  t: number;
}

/** A fixed-cash-flow instrument (zero or coupon bearing), single currency, no default. */
export interface InstrumentInput {
  isin: string;
  valuationDate: string;
  cashFlows: CashFlowInput[];
}

export interface PreparedInstrument {
  isin: string;
  valuationDate: string;
  cashFlows: ScheduledCashFlow[];
  /** Final payment — its date is the maturity and it must create the new node. */
  maturity: ScheduledCashFlow;
  /** All payments strictly earlier than maturity. */
  early: ScheduledCashFlow[];
}

export function prepareInstrument(input: InstrumentInput): PreparedInstrument {
  if (!input.isin || typeof input.isin !== 'string') {
    throw new AppError('VALIDATION_ERROR', 'isin is required');
  }
  if (!Array.isArray(input.cashFlows) || input.cashFlows.length === 0) {
    throw new AppError('VALIDATION_ERROR', `instrument ${input.isin} has no cash flows`);
  }
  const vd = parseIsoDate(input.valuationDate);
  const scheduled = input.cashFlows.map((cf) => {
    if (typeof cf.amount !== 'number' || !Number.isFinite(cf.amount)) {
      throw new AppError('VALIDATION_ERROR', `cash flow amount on ${cf.date} is not finite`);
    }
    const d = parseIsoDate(cf.date);
    return { date: toIso(d), amount: cf.amount, t: yearFraction(vd, d) };
  });

  scheduled.sort((a, b) => a.t - b.t || a.date.localeCompare(b.date));
  for (let i = 1; i < scheduled.length; i++) {
    if (scheduled[i]!.t === scheduled[i - 1]!.t) {
      throw new AppError(
        'UNSUPPORTED_DATE_STRUCTURE',
        `two cash flows of ${input.isin} fall on the same date ${scheduled[i]!.date}; aggregate them first`
      );
    }
  }
  const maturity = scheduled[scheduled.length - 1]!;
  if (!(maturity.amount > 0)) {
    throw new AppError(
      'NON_POSITIVE_FINAL_CASHFLOW',
      `final cash flow of ${input.isin} at ${maturity.date} must be positive, got ${maturity.amount}`
    );
  }
  for (const cf of scheduled) {
    if (!(cf.amount > 0)) {
      throw new AppError(
        'UNSUPPORTED_DATE_STRUCTURE',
        `cash flow of ${input.isin} at ${cf.date} is non-positive (${cf.amount}); only strictly positive flows are bootstrappable`
      );
    }
  }
  return {
    isin: input.isin,
    valuationDate: input.valuationDate,
    cashFlows: scheduled,
    maturity,
    early: scheduled.slice(0, -1)
  };
}

/** Dirty (full) price = quoted clean price + accrued interest. */
export function dirtyPrice(clean: number, accrued: number): number {
  if (typeof clean !== 'number' || !Number.isFinite(clean)) {
    throw new AppError('VALIDATION_ERROR', 'clean/net price must be finite');
  }
  if (typeof accrued !== 'number' || !Number.isFinite(accrued) || accrued < 0) {
    throw new AppError('VALIDATION_ERROR', 'accrued interest must be a finite non-negative number');
  }
  return clean + accrued;
}
