import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { AppError } from '../core/errors.js';
import { MarketDataService } from '../services/market-service.js';
import { CurveService } from '../services/curve-service.js';
import { ValuationService } from '../services/valuation-service.js';
import { ReportService } from '../services/report-service.js';
import { idempotent } from '../services/idempotency.js';
import { DatabaseSync } from 'node:sqlite';

export interface AppServices {
  db: DatabaseSync;
  market: MarketDataService;
  curves: CurveService;
  valuations: ValuationService;
  reports: ReportService;
}

interface Route {
  method: string;
  pattern: RegExp;
  handler: (
    params: Record<string, string>,
    body: any,
    req: IncomingMessage,
    res: ServerResponse,
    url: URL
  ) => unknown;
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const json = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json)
  });
  res.end(json);
}

function pageParams(url: URL): { limit?: number; offset?: number } {
  const limit = url.searchParams.get('limit');
  const offset = url.searchParams.get('offset');
  return {
    limit: limit === null ? undefined : Number(limit),
    offset: offset === null ? undefined : Number(offset)
  };
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new AppError('VALIDATION_ERROR', 'request body too large (max 1MB)'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new AppError('VALIDATION_ERROR', 'request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function createApp(services: AppServices): Server {
  const { db, market, curves, valuations, reports } = services;

  const routes: Route[] = [
    {
      method: 'POST',
      pattern: /^\/api\/instruments$/,
      handler: (_p, body, req) =>
        idempotent(db, req.headers['idempotency-key'] as string | undefined, () =>
          market.importInstrument(body)
        ).result
    },
    {
      method: 'GET',
      pattern: /^\/api\/valuation-dates\/([^/]+)\/instruments$/,
      handler: (p, _b, _req, res, url) => market.listInstruments(p[0]!, pageParams(url!))
    },
    {
      method: 'GET',
      pattern: /^\/api\/instruments\/([^/]+)\/([^/]+)$/,
      handler: (p) => market.getInstrument(decodeURIComponent(p[0]!), p[1]!)
    },
    {
      method: 'POST',
      pattern: /^\/api\/quote-versions$/,
      handler: (_p, body, req) =>
        idempotent(db, req.headers['idempotency-key'] as string | undefined, () =>
          market.createQuoteVersion(body.valuationDate, String(body.label ?? ''), body.quotes)
        ).result
    },
    {
      method: 'GET',
      pattern: /^\/api\/quote-versions$/,
      handler: (_p, _b, _req, res, url) => market.listQuoteVersions(pageParams(url!))
    },
    {
      method: 'GET',
      pattern: /^\/api\/quote-versions\/([^/]+)$/,
      handler: (p) => market.getQuoteVersion(p[0]!)
    },
    {
      method: 'POST',
      pattern: /^\/api\/curves\/build$/,
      handler: (_p, body, req) =>
        idempotent(db, req.headers['idempotency-key'] as string | undefined, () =>
          curves.buildFromQuoteVersion(body.quoteVersionId)
        ).result
    },
    {
      method: 'GET',
      pattern: /^\/api\/curves$/,
      handler: (_p, _b, _req, _res, url) => curves.listCurves(pageParams(url!))
    },
    {
      method: 'GET',
      pattern: /^\/api\/curves\/([^/]+)$/,
      handler: (p) => curves.getCurve(p[0]!)
    },
    {
      method: 'POST',
      pattern: /^\/api\/valuations$/,
      handler: (_p, body, req) =>
        idempotent(db, req.headers['idempotency-key'] as string | undefined, () =>
          valuations.valueBond(body)
        ).result
    },
    {
      method: 'GET',
      pattern: /^\/api\/valuations$/,
      handler: (_p, _b, _req, _res, url) => valuations.listValuations(pageParams(url!))
    },
    {
      method: 'POST',
      pattern: /^\/api\/curves\/compare$/,
      handler: (_p, body) => valuations.compareCurves(body)
    },
    {
      method: 'POST',
      pattern: /^\/api\/reports\/freeze$/,
      handler: (_p, body, req) =>
        idempotent(db, req.headers['idempotency-key'] as string | undefined, () =>
          reports.freezeReport(body.curveId)
        ).result
    },
    {
      method: 'GET',
      pattern: /^\/api\/reports\/by-curve\/([^/]+)$/,
      handler: (p) => reports.getReportByCurve(p[0]!)
    },
    {
      method: 'GET',
      pattern: /^\/api\/health$/,
      handler: () => ({ status: 'ok' })
    }
  ];

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/') {
        return send(res, 200, {
          service: 'curve-bootstrap-demo',
          note: 'JSON API only; no web UI',
          endpoints: routes.map((r) => `${r.method} ${r.pattern.source.replace(/[\\^$]/g, '').replace(/\(\[\^\/\]\+\)/g, '{x}')}`)
        });
      }
      const route = routes.find(
        (r) => r.method === req.method && r.pattern.test(url.pathname)
      );
      if (!route) {
        return send(res, 404, { error: { code: 'NOT_FOUND', message: `no route for ${req.method} ${url.pathname}` } });
      }
      const match = url.pathname.match(route.pattern)!;
      const params: Record<string, string> = {};
      for (let i = 1; i < match.length; i++) params[String(i - 1)] = match[i]!;
      const body = req.method === 'POST' ? await readJson(req) : {};
      const result = await route.handler(params, body, req, res, url);
      if (result !== undefined && !res.writableEnded) send(res, 200, result);
    } catch (err) {
      if (err instanceof AppError) {
        return send(res, err.status, { error: { code: err.code, message: err.message, details: err.details ?? null } });
      }
      return send(res, 500, { error: { code: 'INTERNAL_ERROR', message: String(err) } });
    }
  });

  return server;
}

export async function listenLocalhost(server: Server, preferredPort = 0): Promise<{ port: number; close: () => Promise<void> }> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Bind loopback only. Port 0 => OS picks a free port automatically.
    server.listen(preferredPort, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  };
}
