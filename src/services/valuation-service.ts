import { DatabaseSync } from 'node:sqlite';
import { AppError } from '../core/errors.js';
import { parseIsoDate, toIso, yearFraction } from '../core/dates.js';
import { reprice } from '../core/pricing.js';
import { yieldToMaturity } from '../core/ytm.js';
import { computeDv01, DV01_SHIFT } from '../core/dv01.js';
import { DiscountCurve } from '../core/curve.js';
import { withTransaction, normalisePage, makePage, Page } from '../db/db.js';
import { makeId } from './ids.js';
import { Env, defaultEnv } from './types.js';
import { CurveService } from './curve-service.js';

export interface ValueBondBody {
  curveId: string;
  label?: string;
  cashFlows: { date: string; amount: number }[];
}

export interface CompareBody {
  baseCurveId: string;
  otherCurveId: string;
  dates: string[];
}

export class ValuationService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly curves: CurveService,
    private readonly env: Env = defaultEnv
  ) {}

  private schedule(curve: DiscountCurve, valuationDate: string, flows: { date: string; amount: number }[]) {
    if (!Array.isArray(flows) || flows.length === 0) {
      throw new AppError('VALIDATION_ERROR', 'cashFlows must be a non-empty array');
    }
    const vd = parseIsoDate(valuationDate);
    const out = flows.map((cf) => {
      if (typeof cf.amount !== 'number' || !Number.isFinite(cf.amount)) {
        throw new AppError('VALIDATION_ERROR', `cash flow amount on ${cf.date} is not finite`);
      }
      const d = parseIsoDate(cf.date);
      return { date: toIso(d), amount: cf.amount, t: yearFraction(vd, d) };
    });
    out.sort((a, b) => a.t - b.t);
    // Ensure every payment lies on/inside the curve domain (no extrapolation).
    for (const cf of out) void curve.discountFactor(cf.t);
    return out;
  }

  /** Value a NEW bond (not one of the bootstrapping set) on an existing curve. */
  valueBond(body: ValueBondBody) {
    if (!body || typeof body.curveId !== 'string') {
      throw new AppError('VALIDATION_ERROR', 'curveId is required');
    }
    const { curve, valuationDate } = this.curves.loadRuntimeCurve(body.curveId);
    const schedule = this.schedule(curve, valuationDate, body.cashFlows);
    const { pv, details } = reprice(curve, schedule);
    // Bond-level YTM is distinct from curve zero/forward rates.
    const ytm = yieldToMaturity(schedule, pv);
    const dv01 = computeDv01(
      { valuationDate, nodes: curve.nodes.map((n) => ({ t: n.t, df: n.df, date: n.date })) },
      schedule,
      DV01_SHIFT
    );

    const payload = {
      curveId: body.curveId,
      valuationDate,
      label: typeof body.label === 'string' ? body.label : null,
      pv,
      ytm,
      dv01,
      details
    };

    const id = withTransaction(this.db, () => {
      const valuationId = makeId('val', this.env.rand, this.env.now);
      this.db
        .prepare('INSERT INTO valuations (id, curve_id, label, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(valuationId, body.curveId, payload.label, JSON.stringify(payload), this.env.now().toISOString());
      return valuationId;
    });
    return { id, ...payload };
  }

  /** Compare zero rates / factors of two historical curves at common dates. */
  compareCurves(body: CompareBody) {
    if (!body?.baseCurveId || !body?.otherCurveId) {
      throw new AppError('VALIDATION_ERROR', 'baseCurveId and otherCurveId are required');
    }
    const base = this.curves.loadRuntimeCurve(body.baseCurveId);
    const other = this.curves.loadRuntimeCurve(body.otherCurveId);
    if (base.valuationDate !== other.valuationDate) {
      throw new AppError(
        'VALIDATION_ERROR',
        `valuation dates differ: ${base.valuationDate} vs ${other.valuationDate}`
      );
    }
    const vd = parseIsoDate(base.valuationDate);
    const dates = body.dates && body.dates.length > 0 ? body.dates : base.curve.nodes.map((n) => n.date!).filter(Boolean);
    const points = dates.map((iso) => {
      const d = parseIsoDate(iso);
      const t = yearFraction(vd, d);
      const dfBase = base.curve.discountFactor(t);
      const dfOther = other.curve.discountFactor(t);
      return {
        date: toIso(d),
        t,
        baseDf: dfBase,
        otherDf: dfOther,
        baseZero: -Math.log(dfBase) / t,
        otherZero: -Math.log(dfOther) / t,
        zeroShift: -Math.log(dfOther) / t - -Math.log(dfBase) / t
      };
    });
    return {
      valuationDate: base.valuationDate,
      baseCurveId: body.baseCurveId,
      otherCurveId: body.otherCurveId,
      points
    };
  }

  listValuations(page: { limit?: number; offset?: number } = {}): Page<unknown> {
    const { limit, offset } = normalisePage(page);
    const total = (this.db.prepare('SELECT COUNT(*) AS c FROM valuations').get() as { c: number }).c;
    const rows = this.db
      .prepare('SELECT payload_json FROM valuations ORDER BY created_at DESC, id LIMIT ? OFFSET ?')
      .all(limit, offset) as { payload_json: string }[];
    return makePage(rows.map((r) => JSON.parse(r.payload_json)), limit, offset, total);
  }
}
