import { openDatabase, DbContext } from './db/db.js';
import { MarketDataService } from './services/market-service.js';
import { CurveService } from './services/curve-service.js';
import { ValuationService } from './services/valuation-service.js';
import { ReportService } from './services/report-service.js';
import { AppServices } from './api/server.js';
import { Env, defaultEnv } from './services/types.js';

export interface AppContext extends AppServices {
  dbContext: DbContext;
}

export function buildContext(dbPath: string, env: Env = defaultEnv): AppContext {
  const dbContext = openDatabase(dbPath, env.now);
  const market = new MarketDataService(dbContext.db, env);
  const curves = new CurveService(dbContext.db, market, env);
  const valuations = new ValuationService(dbContext.db, curves, env);
  const reports = new ReportService(dbContext.db, curves, market, env);
  return { db: dbContext.db, dbContext, market, curves, valuations, reports };
}
