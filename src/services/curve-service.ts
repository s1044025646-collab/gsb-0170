import { DatabaseSync } from 'node:sqlite';
import { AppError } from '../core/errors.js';
import { bootstrap, BootstrapQuote } from '../core/bootstrap.js';
import { DiscountCurve } from '../core/curve.js';
import { PreparedInstrument } from '../core/instrument.js';
import { withTransaction, normalisePage, makePage, Page } from '../db/db.js';
import { makeId } from './ids.js';
import { Env, defaultEnv } from './types.js';
import { MarketDataService } from './market-service.js';

export interface CurveRecordSummary {
  id: string;
  quoteVersionId: string;
  valuationDate: string;
  status: 'OK' | 'FAILED';
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export class CurveService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly market: MarketDataService,
    private readonly env: Env = defaultEnv
  ) {}

  /**
   * Build a curve from a quote version. A failed bootstrap is PERSISTED with
   * status FAILED and the structured error, so the attempt is auditable.
   */
  buildFromQuoteVersion(quoteVersionId: string) {
    const version = this.market.getQuoteVersion(quoteVersionId);
    const existing = this.db
      .prepare('SELECT id FROM curves WHERE quote_version_id = ?')
      .get(quoteVersionId) as { id: string } | undefined;
    if (existing) {
      return this.getCurve(existing.id);
    }

    const instruments: PreparedInstrument[] = version.quotes.map((q) => {
      const row = this.db
        .prepare(
          `SELECT payload_json FROM instruments i
           JOIN valuation_dates vd ON vd.id = i.valuation_date_id
           WHERE i.isin = ? AND vd.iso_date = ?`
        )
        .get(q.isin, version.valuationDate) as { payload_json: string } | undefined;
      if (!row) throw new AppError('NOT_FOUND', `instrument ${q.isin} missing`, undefined, 404);
      return JSON.parse(row.payload_json) as PreparedInstrument;
    });
    const quotes: BootstrapQuote[] = version.quotes.map((q) => ({
      isin: q.isin,
      cleanPrice: q.cleanPrice,
      accrued: q.accrued
    }));

    const curveId = makeId('crv', this.env.rand, this.env.now);
    const createdAt = this.env.now().toISOString();

    try {
      const result = bootstrap({ valuationDate: version.valuationDate, instruments, quotes });
      withTransaction(this.db, () => {
        this.db
          .prepare(
            `INSERT INTO curves (id, quote_version_id, valuation_date_id, status, error_code, error_message, error_payload_json, created_at)
             VALUES (?, ?, ?, 'OK', NULL, NULL, NULL, ?)`
          )
          .run(curveId, version.id, version.valuationDateId, createdAt);
        const nodeStmt = this.db.prepare(
          `INSERT INTO curve_nodes (curve_id, ordinal, node_date, t, df, zero_rate) VALUES (?, ?, ?, ?, ?, ?)`
        );
        result.nodes.forEach((n, i) => {
          nodeStmt.run(curveId, i, n.date ?? null, n.t, n.df, -Math.log(n.df) / n.t);
        });
        const stepStmt = this.db.prepare(
          `INSERT INTO bootstrap_steps
             (curve_id, ordinal, isin, maturity_date, t, dirty_price, pv_known, final_amount, df, repriced_dirty, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        result.steps.forEach((s, i) => {
          stepStmt.run(
            curveId, i, s.isin, s.maturityDate, s.t, s.dirtyPrice, s.pvOfKnownFlows,
            s.finalAmount, s.df, s.repricedDirty, s.error
          );
        });
      });
      return this.getCurve(curveId);
    } catch (err) {
      const appErr = err instanceof AppError ? err : new AppError('CONFLICT', String(err));
      withTransaction(this.db, () => {
        this.db
          .prepare(
            `INSERT INTO curves (id, quote_version_id, valuation_date_id, status, error_code, error_message, error_payload_json, created_at)
             VALUES (?, ?, ?, 'FAILED', ?, ?, ?, ?)`
          )
          .run(
            curveId,
            version.id,
            version.valuationDateId,
            appErr.code,
            appErr.message,
            appErr.details === undefined ? null : JSON.stringify(appErr.details),
            createdAt
          );
      });
      throw appErr;
    }
  }

  getCurve(id: string) {
    const header = this.db
      .prepare(
        `SELECT c.id, c.quote_version_id AS quoteVersionId, vd.iso_date AS valuationDate,
                c.status, c.error_code AS errorCode, c.error_message AS errorMessage,
                c.error_payload_json AS errorPayloadJson, c.created_at AS createdAt
         FROM curves c
         JOIN valuation_dates vd ON vd.id = c.valuation_date_id
         WHERE c.id = ?`
      )
      .get(id) as
      | {
          id: string;
          quoteVersionId: string;
          valuationDate: string;
          status: 'OK' | 'FAILED';
          errorCode: string | null;
          errorMessage: string | null;
          errorPayloadJson: string | null;
          createdAt: string;
        }
      | undefined;
    if (!header) throw new AppError('NOT_FOUND', `curve ${id} not found`, undefined, 404);

    const nodes = this.db
      .prepare(
        `SELECT node_date AS date, t, df, zero_rate AS zero
         FROM curve_nodes WHERE curve_id = ? ORDER BY ordinal`
      )
      .all(id) as { date: string | null; t: number; df: number; zero: number }[];
    const steps = this.db
      .prepare(
        `SELECT isin, maturity_date AS maturityDate, t, dirty_price AS dirtyPrice,
                pv_known AS pvKnown, final_amount AS finalAmount, df,
                repriced_dirty AS repricedDirty, error
         FROM bootstrap_steps WHERE curve_id = ? ORDER BY ordinal`
      )
      .all(id) as unknown[];

    return {
      ...header,
      errorPayload: header.errorPayloadJson ? JSON.parse(header.errorPayloadJson) : null,
      nodes: nodes.map((n) => ({ ...n, date: n.date ?? undefined })),
      steps
    };
  }

  /** Rebuild a runtime DiscountCurve object from persisted nodes. */
  loadRuntimeCurve(id: string): { curve: DiscountCurve; valuationDate: string } {
    const record = this.getCurve(id);
    if (record.status !== 'OK') {
      throw new AppError('CONFLICT', `curve ${id} is FAILED (${record.errorCode}); cannot value on it`);
    }
    const curve = new DiscountCurve({
      valuationDate: record.valuationDate,
      nodes: record.nodes.map((n) => ({ t: n.t, df: n.df, date: n.date }))
    });
    return { curve, valuationDate: record.valuationDate };
  }

  listCurves(page: { limit?: number; offset?: number } = {}): Page<CurveRecordSummary> {
    const { limit, offset } = normalisePage(page);
    const total = (this.db.prepare('SELECT COUNT(*) AS c FROM curves').get() as { c: number }).c;
    const rows = this.db
      .prepare(
        `SELECT c.id, c.quote_version_id AS quoteVersionId, vd.iso_date AS valuationDate,
                c.status, c.error_code AS errorCode, c.error_message AS errorMessage,
                c.created_at AS createdAt
         FROM curves c JOIN valuation_dates vd ON vd.id = c.valuation_date_id
         ORDER BY c.created_at DESC, c.id LIMIT ? OFFSET ?`
      )
      .all(limit, offset) as unknown as CurveRecordSummary[];
    return makePage(rows, limit, offset, total);
  }
}
