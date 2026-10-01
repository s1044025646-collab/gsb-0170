import type { DatabaseSync } from 'node:sqlite';
import { bootstrapCurve } from '../core/bootstrap.js';
import { DiscountCurve, yieldToMaturity } from '../core/curve.js';
import { computeDV01 } from '../core/sensitivity.js';
import { DomainError } from '../core/errors.js';
import { assertISODate } from '../core/time.js';
import type { InstrumentInput } from '../core/types.js';
import {
  getCurveNodes,
  getCurveResiduals,
  getCurveVersion,
  getQuoteVersion,
  getQuotesForVersion,
  insertQuoteVersion,
  persistCurveVersion,
  type CurveVersionRow,
} from '../db/repo.js';

export interface Clock {
  now(): Date;
}

export function validateInstrumentInput(body: unknown): {
  label: string;
  valueDate: string;
  instruments: InstrumentInput[];
  idempotencyKey?: string;
} {
  if (typeof body !== 'object' || body === null) {
    throw Object.assign(new Error('request body must be an object'), { name: 'ValidationError' });
  }
  const b = body as Record<string, unknown>;
  if (typeof b.label !== 'string' || b.label.trim().length === 0) {
    throw Object.assign(new Error('label is required'), { name: 'ValidationError' });
  }
  if (typeof b.valueDate !== 'string') {
    throw Object.assign(new Error('valueDate must be an ISO date'), { name: 'ValidationError' });
  }
  assertISODate(b.valueDate, 'valueDate');
  if (!Array.isArray(b.instruments) || b.instruments.length === 0) {
    throw Object.assign(new Error('instruments must be a non-empty array'), {
      name: 'ValidationError',
    });
  }

  const instruments: InstrumentInput[] = b.instruments.map((raw) => {
    if (typeof raw !== 'object' || raw === null) {
      throw Object.assign(new Error('each instrument must be an object'), { name: 'ValidationError' });
    }
    const inst = raw as Record<string, unknown>;
    if (typeof inst.instrumentId !== 'string' || inst.instrumentId.length === 0) {
      throw Object.assign(new Error('instrumentId is required'), { name: 'ValidationError' });
    }
    if (typeof inst.cleanPrice !== 'number' || !Number.isFinite(inst.cleanPrice)) {
      throw Object.assign(new Error(`${inst.instrumentId}: cleanPrice must be a finite number`), {
        name: 'ValidationError',
      });
    }
    if (typeof inst.accruedInterest !== 'number' || !Number.isFinite(inst.accruedInterest)) {
      throw Object.assign(new Error(`${inst.instrumentId}: accruedInterest must be a finite number`), {
        name: 'ValidationError',
      });
    }
    if (!Array.isArray(inst.cashflows) || inst.cashflows.length === 0) {
      throw Object.assign(new Error(`${inst.instrumentId}: cashflows must be a non-empty array`), {
        name: 'ValidationError',
      });
    }
    const cashflows = inst.cashflows.map((cfRaw) => {
      if (typeof cfRaw !== 'object' || cfRaw === null) {
        throw Object.assign(new Error(`${inst.instrumentId}: cashflow must be an object`), {
          name: 'ValidationError',
        });
      }
      const cf = cfRaw as Record<string, unknown>;
      if (typeof cf.payDate !== 'string') {
        throw Object.assign(new Error(`${inst.instrumentId}: cashflow payDate required`), {
          name: 'ValidationError',
        });
      }
      assertISODate(cf.payDate, `${inst.instrumentId}.payDate`);
      if (typeof cf.amount !== 'number' || !Number.isFinite(cf.amount)) {
        throw Object.assign(new Error(`${inst.instrumentId}: cashflow amount must be finite`), {
          name: 'ValidationError',
        });
      }
      return { payDate: cf.payDate, amount: cf.amount };
    });
    return {
      instrumentId: inst.instrumentId,
      quoteVersionId: '',
      cleanPrice: inst.cleanPrice,
      accruedInterest: inst.accruedInterest,
      cashflows,
    };
  });

  const result: ReturnType<typeof validateInstrumentInput> = {
    label: b.label,
    valueDate: b.valueDate,
    instruments,
  };
  if (b.idempotencyKey !== undefined) {
    if (typeof b.idempotencyKey !== 'string' || b.idempotencyKey.length === 0) {
      throw Object.assign(new Error('idempotencyKey must be a non-empty string'), {
        name: 'ValidationError',
      });
    }
    result.idempotencyKey = b.idempotencyKey;
  }
  return result;
}

export function importQuoteVersion(
  db: DatabaseSync,
  input: ReturnType<typeof validateInstrumentInput>,
  clock: Clock,
) {
  const { version, created } = insertQuoteVersion(db, {
    label: input.label,
    valueDate: input.valueDate,
    instruments: input.instruments,
    idempotencyKey: input.idempotencyKey,
    now: clock.now().toISOString(),
  });
  return { version, created };
}

// Build a curve version. Domain failures are recorded as status='failed'
// inside a transaction (and rolled back only on infrastructure errors),
// so the reason for rejection is preserved without hiding it.
export function buildCurveVersion(
  db: DatabaseSync,
  quoteVersionId: string,
  clock: Clock,
  options?: { idempotencyKey?: string },
): { curveVersion: CurveVersionRow; result: ReturnType<typeof bootstrapCurve> | null } {
  const quoteVersion = getQuoteVersion(db, quoteVersionId);
  if (!quoteVersion) {
    throw Object.assign(new Error(`quote version ${quoteVersionId} not found`), { name: 'NotFound' });
  }
  const quoteDetails = getQuotesForVersion(db, quoteVersion.id);
  const instruments: InstrumentInput[] = quoteDetails.map((q) => ({
    instrumentId: q.instrument_id,
    quoteVersionId: quoteVersion.id,
    cleanPrice: q.clean_price,
    accruedInterest: q.accrued_interest,
    cashflows: q.cashflows.map((cf) => ({ payDate: cf.pay_date, amount: cf.amount })),
  }));

  const now = clock.now().toISOString();
  try {
    const result = bootstrapCurve(quoteVersion.value_date, instruments);
    const curveVersion = persistCurveVersion(db, {
      quoteVersion,
      result,
      status: 'built',
      idempotencyKey: options?.idempotencyKey,
      now,
    });
    return { curveVersion, result };
  } catch (err) {
    if (err instanceof DomainError) {
      const curveVersion = persistCurveVersion(db, {
        quoteVersion,
        result: null,
        status: 'failed',
        errorCode: err.code,
        errorMessage: err.message,
        idempotencyKey: options?.idempotencyKey,
        now,
      });
      return { curveVersion, result: null };
    }
    throw err;
  }
}

export function loadCurve(db: DatabaseSync, curveVersionId: string): DiscountCurve {
  const cv = getCurveVersion(db, curveVersionId);
  if (!cv) throw Object.assign(new Error('curve version not found'), { name: 'NotFound' });
  if (cv.status !== 'built' && cv.status !== 'frozen') {
    throw new DomainError('NOT_FOUND', `curve version ${curveVersionId} did not build successfully`, {
      status: cv.status,
      buildErrorCode: cv.build_error_code,
    });
  }
  const nodeRows = getCurveNodes(db, curveVersionId);
  return new DiscountCurve(
    cv.value_date,
    nodeRows.map((n) => ({
      payDate: n.pay_date,
      yearFraction: n.yearFraction,
      discountFactor: n.discountFactor,
      zeroRate: n.zeroRate,
    })),
  );
}

export function curveDetails(db: DatabaseSync, curveVersionId: string) {
  const cv = getCurveVersion(db, curveVersionId);
  if (!cv) throw Object.assign(new Error('curve version not found'), { name: 'NotFound' });
  return {
    curveVersion: cv,
    nodes: getCurveNodes(db, curveVersionId),
    residuals: getCurveResiduals(db, curveVersionId),
  };
}

export function valueBondOnCurve(
  db: DatabaseSync,
  curveVersionId: string,
  cashflows: { payDate: string; amount: number }[],
  accruedInterest: number,
) {
  const cv = getCurveVersion(db, curveVersionId);
  if (!cv) throw Object.assign(new Error('curve version not found'), { name: 'NotFound' });
  const nodes = getCurveNodes(db, curveVersionId).map((n) => ({
    payDate: n.pay_date,
    yearFraction: n.yearFraction,
    discountFactor: n.discountFactor,
    zeroRate: n.zeroRate,
  }));
  const { valueCashflows } = await_import();
  const valuation = valueCashflows(cv.value_date, nodes, cashflows, accruedInterest);
  let ytm: number | null = null;
  try {
    ytm = yieldToMaturity(cv.value_date, cashflows, valuation.dirtyPrice);
  } catch {
    ytm = null;
  }
  const dv01 = computeDV01(cv.value_date, nodes, cashflows, accruedInterest);
  return { valuation, ytm, dv01 };
}

// Avoid a static import cycle by importing valueCashflows lazily (same module
// graph, no cycle in practice; kept simple).
function await_import() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = bootstrapModule;
  return { valueCashflows: mod.valueCashflows };
}

import * as bootstrapModule from '../core/bootstrap.js';
