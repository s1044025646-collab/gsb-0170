import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { BootstrapResult, InstrumentInput } from '../core/types.js';

export interface PageParams {
  limit: number;
  offset: number;
}

export interface QuoteVersionRow {
  id: string;
  label: string;
  value_date: string;
  created_at: string;
  idempotency_key: string | null;
}

export interface CashflowRow {
  quote_version_id: string;
  instrument_id: string;
  pay_date: string;
  amount: number;
  ordinal: number;
}

export interface QuoteDetailRow {
  instrument_id: string;
  clean_price: number;
  accrued_interest: number;
  cashflows: CashflowRow[];
}

export interface CurveVersionRow {
  id: string;
  quote_version_id: string;
  value_date: string;
  status: string;
  created_at: string;
  frozen_at: string | null;
  build_error_code: string | null;
  build_error_message: string | null;
  idempotency_key: string | null;
}

export function paginate(limitInput: unknown, offsetInput: unknown): PageParams {
  const limit = Number(limitInput ?? 50);
  const offset = Number(offsetInput ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw Object.assign(new Error('limit must be an integer between 1 and 200'), {
      name: 'ValidationError',
    });
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw Object.assign(new Error('offset must be a non-negative integer'), {
      name: 'ValidationError',
    });
  }
  return { limit, offset };
}

// Insert an immutable quote version. Re-submitting the same idempotency key
// returns the previously stored version instead of creating a duplicate.
export function insertQuoteVersion(
  db: DatabaseSync,
  args: {
    label: string;
    valueDate: string;
    instruments: InstrumentInput[];
    idempotencyKey?: string;
    now: string;
  },
): { version: QuoteVersionRow; created: boolean } {
  if (args.idempotencyKey) {
    const existing = db
      .prepare('SELECT * FROM quote_versions WHERE idempotency_key = ?')
      .get(args.idempotencyKey) as QuoteVersionRow | undefined;
    if (existing) return { version: existing, created: false };
  }

  const id = randomUUID();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO quote_versions(id, label, value_date, created_at, idempotency_key)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, args.label, args.valueDate, args.now, args.idempotencyKey ?? null);

    const insInstrument = db.prepare('INSERT OR IGNORE INTO instruments(id, created_at) VALUES (?, ?)');
    const insQuote = db.prepare(
      `INSERT INTO instrument_quotes(quote_version_id, instrument_id, clean_price, accrued_interest, created_at, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insCf = db.prepare(
      `INSERT INTO cashflows(instrument_id, quote_version_id, pay_date, amount, ordinal)
       VALUES (?, ?, ?, ?, ?)`,
    );

    for (const inst of args.instruments) {
      insInstrument.run(inst.instrumentId, args.now);
      insQuote.run(
        id,
        inst.instrumentId,
        inst.cleanPrice,
        inst.accruedInterest,
        args.now,
        args.idempotencyKey ? `${args.idempotencyKey}:${inst.instrumentId}` : null,
      );
      inst.cashflows.forEach((cf, ordinal) => {
        insCf.run(inst.instrumentId, id, cf.payDate, cf.amount, ordinal);
      });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const version = db.prepare('SELECT * FROM quote_versions WHERE id = ?').get(id) as QuoteVersionRow;
  return { version, created: true };
}

export function listQuoteVersions(db: DatabaseSync, page: PageParams) {
  const total = (db.prepare('SELECT COUNT(*) AS n FROM quote_versions').get() as { n: number }).n;
  const rows = db
    .prepare('SELECT * FROM quote_versions ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?')
    .all(page.limit, page.offset) as QuoteVersionRow[];
  return { total, items: rows };
}

export function getQuoteVersion(db: DatabaseSync, id: string): QuoteVersionRow | undefined {
  return db.prepare('SELECT * FROM quote_versions WHERE id = ?').get(id) as QuoteVersionRow | undefined;
}

export function getQuotesForVersion(db: DatabaseSync, quoteVersionId: string): QuoteDetailRow[] {
  const quotes = db
    .prepare(
      `SELECT instrument_id, clean_price, accrued_interest
         FROM instrument_quotes WHERE quote_version_id = ? ORDER BY id`,
    )
    .all(quoteVersionId) as Omit<QuoteDetailRow, 'cashflows'>[];
  const cfs = db
    .prepare(
      `SELECT quote_version_id, instrument_id, pay_date, amount, ordinal
         FROM cashflows WHERE quote_version_id = ? ORDER BY instrument_id, ordinal`,
    )
    .all(quoteVersionId) as CashflowRow[];
  return quotes.map((q) => ({
    ...q,
    cashflows: cfs.filter((cf) => cf.instrument_id === q.instrument_id),
  }));
}

export interface PersistCurveArgs {
  quoteVersion: QuoteVersionRow;
  result: BootstrapResult | null;
  status: 'built' | 'failed';
  errorCode?: string;
  errorMessage?: string;
  idempotencyKey?: string;
  now: string;
}

export function persistCurveVersion(db: DatabaseSync, args: PersistCurveArgs): CurveVersionRow {
  if (args.idempotencyKey) {
    const existing = db
      .prepare('SELECT * FROM curve_versions WHERE idempotency_key = ?')
      .get(args.idempotencyKey) as CurveVersionRow | undefined;
    if (existing) return existing;
  }

  const id = randomUUID();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO curve_versions
        (id, quote_version_id, value_date, status, created_at, build_error_code, build_error_message, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      args.quoteVersion.id,
      args.quoteVersion.value_date,
      args.status,
      args.now,
      args.errorCode ?? null,
      args.errorMessage ?? null,
      args.idempotencyKey ?? null,
    );

    if (args.result) {
      const insNode = db.prepare(
        `INSERT INTO curve_nodes(curve_version_id, pay_date, year_fraction, discount_factor, zero_rate, ordinal)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const insRes = db.prepare(
        `INSERT INTO curve_residuals
          (curve_version_id, instrument_id, maturity_date, quoted_clean_price, quoted_accrued_interest,
           quoted_dirty_price, model_dirty_price, error, ordinal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      args.result.nodes.forEach((node, ordinal) => {
        insNode.run(id, node.payDate, node.yearFraction, node.discountFactor, node.zeroRate, ordinal);
      });
      const details = getQuotesForVersion(db, args.quoteVersion.id);
      args.result.residuals.forEach((r, ordinal) => {
        const q = details.find((d) => d.instrument_id === r.instrumentId);
        insRes.run(
          id,
          r.instrumentId,
          r.maturityDate,
          q?.clean_price ?? 0,
          q?.accrued_interest ?? 0,
          r.quotedDirtyPrice,
          r.modelDirtyPrice,
          r.error,
          ordinal,
        );
      });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return db.prepare('SELECT * FROM curve_versions WHERE id = ?').get(id) as CurveVersionRow;
}

export function listCurveVersions(db: DatabaseSync, page: PageParams) {
  const total = (db.prepare('SELECT COUNT(*) AS n FROM curve_versions').get() as { n: number }).n;
  const rows = db
    .prepare('SELECT * FROM curve_versions ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?')
    .all(page.limit, page.offset) as CurveVersionRow[];
  return { total, items: rows };
}

export function getCurveVersion(db: DatabaseSync, id: string): CurveVersionRow | undefined {
  return db.prepare('SELECT * FROM curve_versions WHERE id = ?').get(id) as CurveVersionRow | undefined;
}

export function getCurveNodes(db: DatabaseSync, curveVersionId: string) {
  return db
    .prepare(
      `SELECT pay_date, year_fraction AS yearFraction, discount_factor AS discountFactor, zero_rate AS zeroRate
         FROM curve_nodes WHERE curve_version_id = ? ORDER BY ordinal`,
    )
    .all(curveVersionId) as {
    pay_date: string;
    yearFraction: number;
    discountFactor: number;
    zeroRate: number;
  }[];
}

export function getCurveResiduals(db: DatabaseSync, curveVersionId: string) {
  return db
    .prepare(
      `SELECT instrument_id AS instrumentId, maturity_date AS maturityDate,
              quoted_clean_price AS quotedCleanPrice, quoted_accrued_interest AS quotedAccruedInterest,
              quoted_dirty_price AS quotedDirtyPrice, model_dirty_price AS modelDirtyPrice, error
         FROM curve_residuals WHERE curve_version_id = ? ORDER BY ordinal`,
    )
    .all(curveVersionId);
}

// Freezing marks a report immutable. Historical curve versions are never
// overwritten by new builds; frozen status itself is guarded.
export function freezeCurveVersion(db: DatabaseSync, id: string, now: string): CurveVersionRow {
  const row = getCurveVersion(db, id);
  if (!row) {
    throw Object.assign(new Error('curve version not found'), { name: 'NotFound' });
  }
  if (row.status === 'frozen') return row;
  if (row.status !== 'built') {
    throw Object.assign(new Error(`cannot freeze curve version with status ${row.status}`), {
      name: 'VersionFrozen',
    });
  }
  db.prepare("UPDATE curve_versions SET status = 'frozen', frozen_at = ? WHERE id = ?").run(now, id);
  return getCurveVersion(db, id)!;
}
