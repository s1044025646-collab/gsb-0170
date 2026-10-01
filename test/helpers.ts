import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/db.js';
import { MarketDataService } from '../src/services/market-service.js';
import { CurveService } from '../src/services/curve-service.js';
import { ValuationService } from '../src/services/valuation-service.js';
import { ReportService } from '../src/services/report-service.js';
import { Env } from '../src/services/types.js';

export function makeEnv(seed = 1): Required<Env> {
  let state = seed >>> 0;
  return {
    now: () => new Date('2026-09-30T00:00:00.000Z'),
    // deterministic LCG for id bytes
    rand: () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    }
  };
}

export function makeServices(dbPath: string = ':memory:', env = makeEnv()) {
  const ctx = openDatabase(dbPath, env.now);
  const market = new MarketDataService(ctx.db, env);
  const curves = new CurveService(ctx.db, market, env);
  const valuations = new ValuationService(ctx.db, curves, env);
  const reports = new ReportService(ctx.db, curves, market, env);
  return {
    db: ctx.db as DatabaseSync,
    close: () => ctx.close(),
    market,
    curves,
    valuations,
    reports
  };
}

export const VD = '2026-09-30';
