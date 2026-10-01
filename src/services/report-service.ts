import { DatabaseSync } from 'node:sqlite';
import { AppError } from '../core/errors.js';
import { DiscountCurve } from '../core/curve.js';
import { Env, defaultEnv } from './types.js';
import { makeId } from './ids.js';
import { CurveService } from './curve-service.js';
import { MarketDataService } from './market-service.js';

/**
 * Freeze an immutable report for a curve. The report embeds the ORIGINAL
 * quotes and the per-instrument repricing errors, so later quote revisions
 * never overwrite history.
 */
export class ReportService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly curves: CurveService,
    private readonly market: MarketDataService,
    private readonly env: Env = defaultEnv
  ) {}

  freezeReport(curveId: string) {
    const existing = this.db
      .prepare('SELECT id, payload_json, frozen_at FROM reports WHERE curve_id = ?')
      .get(curveId) as { id: string; payload_json: string; frozen_at: string } | undefined;
    if (existing) {
      return { id: existing.id, frozenAt: existing.frozen_at, ...JSON.parse(existing.payload_json) };
    }

    const curve = this.curves.getCurve(curveId);
    const quoteVersion = this.market.getQuoteVersion(curve.quoteVersionId);

    let description: ReturnType<DiscountCurve['describe']> | null = null;
    if (curve.status === 'OK') {
      const runtime = new DiscountCurve({
        valuationDate: curve.valuationDate,
        nodes: curve.nodes.map((n) => ({ t: n.t, df: n.df, date: n.date }))
      });
      description = runtime.describe();
    }

    const payload = {
      curveId,
      status: curve.status,
      valuationDate: curve.valuationDate,
      quoteVersion: {
        id: quoteVersion.id,
        label: quoteVersion.label,
        createdAt: quoteVersion.createdAt,
        quotes: quoteVersion.quotes
      },
      nodes: curve.nodes,
      bootstrapSteps: curve.steps,
      description,
      failure:
        curve.status === 'FAILED'
          ? {
              code: curve.errorCode,
              message: curve.errorMessage,
              details: curve.errorPayload
            }
          : null,
      conventions: {
        dayCount: 'ACT/365F',
        zeroCompounding: 'CONTINUOUS',
        forwardType: 'SIMPLE_INTERVAL_CONTINUOUS',
        interpolation: 'LINEAR_IN_LOG_DISCOUNT_FACTOR',
        extrapolation: 'DENIED',
        dv01Bump: 'PARALLEL_ZERO_RATE_PLUS_MINUS_1BP_CASH_FLOWS_FIXED'
      },
      disclaimer: 'Fictional quotes for teaching only. Reprices the input dirty prices; errors are preserved.'
    };

    const id = makeId('rpt', this.env.rand, this.env.now);
    const frozenAt = this.env.now().toISOString();
    this.db
      .prepare('INSERT INTO reports (id, curve_id, payload_json, frozen_at) VALUES (?, ?, ?, ?)')
      .run(id, curveId, JSON.stringify(payload), frozenAt);
    return { id, frozenAt, ...payload };
  }

  getReportByCurve(curveId: string) {
    const row = this.db
      .prepare('SELECT id, payload_json, frozen_at FROM reports WHERE curve_id = ?')
      .get(curveId) as { id: string; payload_json: string; frozen_at: string } | undefined;
    if (!row) throw new AppError('NOT_FOUND', `no frozen report for curve ${curveId}`, undefined, 404);
    return { id: row.id, frozenAt: row.frozen_at, ...JSON.parse(row.payload_json) };
  }
}
