import { DatabaseSync } from 'node:sqlite';
import { AppError } from '../core/errors.js';
import { parseIsoDate, toIso, assertFiniteNumber } from '../core/dates.js';
import { prepareInstrument, InstrumentInput } from '../core/instrument.js';
import { withTransaction, normalisePage, makePage, Page } from '../db/db.js';
import { makeId } from './ids.js';
import { Env } from './types.js';
import { defaultEnv } from './types.js';

export interface ImportInstrumentBody {
  isin: string;
  valuationDate: string;
  cashFlows: { date: string; amount: number }[];
}

export interface QuoteInput {
  isin: string;
  cleanPrice: number;
  accrued: number;
}

export interface QuoteVersionRecord {
  id: string;
  valuationDateId: string;
  valuationDate: string;
  label: string;
  createdAt: string;
}

export class MarketDataService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly env: Env = defaultEnv
  ) {}

/** Ensure a valuation date row exists; returns its internal id. */
  ensureValuationDate(iso: string): { id: string; isoDate: string } {
    const d = parseIsoDate(iso);
    const normalised = toIso(d);
    const existing = this.db
      .prepare('SELECT id, iso_date FROM valuation_dates WHERE iso_date = ?')
      .get(normalised) as { id: string; iso_date: string } | undefined;
    if (existing) return { id: existing.id, isoDate: existing.iso_date };
    const id = makeId('vd', this.env.rand, this.env.now);
    this.db
      .prepare('INSERT INTO valuation_dates (id, iso_date, created_at) VALUES (?, ?, ?)')
      .run(id, normalised, this.env.now().toISOString());
    return { id, isoDate: normalised };
  }

  /** Import (or re-import idempotently) one instrument and its cash flows. */
  importInstrument(body: ImportInstrumentBody) {
    if (!body || typeof body.isin !== 'string' || !body.isin.trim()) {
      throw new AppError('VALIDATION_ERROR', 'isin is required');
    }
    const vd = this.ensureValuationDate(body.valuationDate);
    const input: InstrumentInput = {
      isin: body.isin.trim(),
      valuationDate: vd.isoDate,
      cashFlows: (body.cashFlows ?? []).map((cf) => ({
        date: cf.date,
        amount: assertFiniteNumber(cf.amount, 'cashFlow.amount')
      }))
    };
    const prepared = prepareInstrument(input);

    withTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO instruments (isin, valuation_date_id, payload_json, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(isin, valuation_date_id) DO UPDATE SET payload_json = excluded.payload_json`
        )
        .run(prepared.isin, vd.id, JSON.stringify(prepared), this.env.now().toISOString());
      this.db
        .prepare('DELETE FROM cash_flows WHERE isin = ? AND valuation_date_id = ?')
        .run(prepared.isin, vd.id);
      const stmt = this.db.prepare(
        `INSERT INTO cash_flows (isin, valuation_date_id, pay_date, amount, ordinal)
         VALUES (?, ?, ?, ?, ?)`
      );
      prepared.cashFlows.forEach((cf, i) => stmt.run(prepared.isin, vd.id, cf.date, cf.amount, i));
    });

    return {
      isin: prepared.isin,
      valuationDate: prepared.valuationDate,
      cashFlowCount: prepared.cashFlows.length,
      maturityDate: prepared.maturity.date,
      finalAmount: prepared.maturity.amount
    };
  }

  getInstrument(isin: string, valuationDate: string) {
    const vd = this.valuationRow(valuationDate);
    const row = this.db
      .prepare('SELECT payload_json FROM instruments WHERE isin = ? AND valuation_date_id = ?')
      .get(isin, vd.id) as { payload_json: string } | undefined;
    if (!row) throw new AppError('NOT_FOUND', `instrument ${isin} not found on ${vd.isoDate}`, undefined, 404);
    return JSON.parse(row.payload_json) as ReturnType<MarketDataService['importInstrument']> & {
      cashFlows: unknown[];
    };
  }

  private valuationRow(iso: string) {
    const normalised = toIso(parseIsoDate(iso));
    const row = this.db
      .prepare('SELECT id, iso_date FROM valuation_dates WHERE iso_date = ?')
      .get(normalised) as { id: string; iso_date: string } | undefined;
    if (!row) throw new AppError('NOT_FOUND', `valuation date ${normalised} has no data`, undefined, 404);
    return { id: row.id, isoDate: row.iso_date };
  }

  listInstruments(iso: string, page: { limit?: number; offset?: number } = {}): Page<unknown> {
    const vd = this.valuationRow(iso);
    const { limit, offset } = normalisePage(page);
    const total = (
      this.db
        .prepare('SELECT COUNT(*) AS c FROM instruments WHERE valuation_date_id = ?')
        .get(vd.id) as { c: number }
    ).c;
    const rows = this.db
      .prepare(
        `SELECT payload_json FROM instruments WHERE valuation_date_id = ?
         ORDER BY isin LIMIT ? OFFSET ?`
      )
      .all(vd.id, limit, offset) as { payload_json: string }[];
    return makePage(rows.map((r) => JSON.parse(r.payload_json)), limit, offset, total);
  }

  /** Create an immutable quote version. Revisions create NEW versions. */
  createQuoteVersion(valuationDate: string, label: string, quotes: QuoteInput[]) {
    if (!Array.isArray(quotes) || quotes.length === 0) {
      throw new AppError('VALIDATION_ERROR', 'at least one quote is required');
    }
    const seen = new Set<string>();
    for (const q of quotes) {
      if (!q || typeof q.isin !== 'string' || !q.isin.trim()) {
        throw new AppError('VALIDATION_ERROR', 'each quote needs an isin');
      }
      assertFiniteNumber(q.cleanPrice, 'cleanPrice');
      if (typeof q.accrued !== 'number' || !Number.isFinite(q.accrued) || q.accrued < 0) {
        throw new AppError('VALIDATION_ERROR', `accrued for ${q.isin} must be >= 0`);
      }
      if (seen.has(q.isin)) throw new AppError('VALIDATION_ERROR', `duplicate quote for ${q.isin} in version`);
      seen.add(q.isin);
    }
    const vd = this.ensureValuationDate(valuationDate);

    // Every quoted instrument must exist on this valuation date.
    for (const q of quotes) {
      const exists = this.db
        .prepare('SELECT 1 FROM instruments WHERE isin = ? AND valuation_date_id = ?')
        .get(q.isin, vd.id);
      if (!exists) throw new AppError('NOT_FOUND', `instrument ${q.isin} not imported on ${vd.isoDate}`, undefined, 404);
    }

    return withTransaction(this.db, () => {
      const id = makeId('qv', this.env.rand, this.env.now);
      this.db
        .prepare(
          'INSERT INTO quote_versions (id, valuation_date_id, label, created_at) VALUES (?, ?, ?, ?)'
        )
        .run(id, vd.id, label, this.env.now().toISOString());
      const stmt = this.db.prepare(
        'INSERT INTO quotes (quote_version_id, isin, clean_price, accrued, created_at) VALUES (?, ?, ?, ?, ?)'
      );
      for (const q of quotes) {
        stmt.run(id, q.isin, q.cleanPrice, q.accrued, this.env.now().toISOString());
      }
      return this.getQuoteVersion(id);
    });
  }

  getQuoteVersion(id: string): QuoteVersionRecord & { quotes: QuoteInput[] } {
    const header = this.db
      .prepare(
        `SELECT qv.id, qv.valuation_date_id, vd.iso_date, qv.label, qv.created_at
         FROM quote_versions qv JOIN valuation_dates vd ON vd.id = qv.valuation_date_id
         WHERE qv.id = ?`
      )
      .get(id) as
      | { id: string; valuation_date_id: string; iso_date: string; label: string; created_at: string }
      | undefined;
    if (!header) throw new AppError('NOT_FOUND', `quote version ${id} not found`, undefined, 404);
    const quotes = this.db
      .prepare('SELECT isin, clean_price AS cleanPrice, accrued FROM quotes WHERE quote_version_id = ? ORDER BY isin')
      .all(id) as unknown as QuoteInput[];
    return {
      id: header.id,
      valuationDateId: header.valuation_date_id,
      valuationDate: header.iso_date,
      label: header.label,
      createdAt: header.created_at,
      quotes
    };
  }

  listQuoteVersions(page: { limit?: number; offset?: number } = {}): Page<QuoteVersionRecord> {
    const { limit, offset } = normalisePage(page);
    const total = (this.db.prepare('SELECT COUNT(*) AS c FROM quote_versions').get() as { c: number }).c;
    const rows = this.db
      .prepare(
        `SELECT qv.id, qv.valuation_date_id AS valuationDateId, vd.iso_date AS valuationDate,
                qv.label, qv.created_at AS createdAt
         FROM quote_versions qv JOIN valuation_dates vd ON vd.id = qv.valuation_date_id
         ORDER BY qv.created_at DESC, qv.id LIMIT ? OFFSET ?`
      )
      .all(limit, offset) as unknown as QuoteVersionRecord[];
    return makePage(rows, limit, offset, total);
  }
}
