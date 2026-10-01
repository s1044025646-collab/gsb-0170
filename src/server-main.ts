import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { buildContext } from './app-context.js';
import { createApp, listenLocalhost } from './api/server.js';
import { seedScenario } from './data/seed.js';

/**
 * Entry point. Everything lives inside the project:
 *   data/app.sqlite  - database
 *   .run/server.json - port + pid (so stop only touches THIS project)
 */
async function main(): Promise<void> {
  const root = process.cwd();
  const dbPath = process.env.CURVE_DB_PATH ?? resolve(root, 'data', 'app.sqlite');
  const runDir = resolve(root, '.run');
  mkdirSync(runDir, { recursive: true });
  mkdirSync(dirname(dbPath), { recursive: true });

  const ctx = buildContext(dbPath);
  if (process.env.SEED_DEMO !== 'false') {
    const existing = ctx.db.prepare('SELECT COUNT(*) AS c FROM instruments').get() as { c: number };
    if (existing.c === 0) seedScenario(ctx.market);
  }

  const server = createApp(ctx);
  const preferred = process.env.PORT ? Number(process.env.PORT) : 0;
  const { port } = await listenLocalhost(server, preferred);
  writeFileSync(
    resolve(runDir, 'server.json'),
    JSON.stringify({ port, pid: process.pid, dbPath, startedAt: new Date().toISOString() }, null, 2)
  );
  // eslint-disable-next-line no-console
  console.log(`[curve-bootstrap] API on http://127.0.0.1:${port} (pid ${process.pid}, db ${dbPath})`);

  const shutdown = () => {
    server.close(() => {
      ctx.dbContext.close();
      try {
        rmSync(resolve(runDir, 'server.json'), { force: true });
      } catch {
        // ignore
      }
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
