#!/usr/bin/env node
import { resolve } from 'node:path';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { buildContext } from '../app-context.js';
import { seedScenario, VALUATION_DATE } from '../data/seed.js';
import { AppError } from '../core/errors.js';

function usage(): void {
  process.stdout.write(
    [
      'curve-bootstrap CLI (teaching demo, fictional quotes)',
      '',
      'Usage:',
      '  cli init-db',
      '  cli seed-demo',
      '  cli import-instruments <file.json>',
      '  cli validate-payments <valuationDate> <isin>',
      '  cli create-quote-version <label> <file.json>',
      '  cli list-versions',
      '  cli build-curve <quoteVersionId>',
      '  cli list-curves',
      '  cli show-curve <curveId>',
      '  cli rates <curveId>',
      '  cli value-bond <curveId> <file.json> [label]',
      '  cli dv01 <curveId> <file.json>',
      '  cli compare <baseCurveId> <otherCurveId> [datesCommaSeparated]',
      '  cli freeze-report <curveId>',
      '  cli show-report <curveId>',
      '  cli serve [port]',
      '  cli stop',
      '',
      'Env: CURVE_DB_PATH (default ./data/app.sqlite)',
      ''
    ].join('\n')
  );
}

const dbPath = process.env.CURVE_DB_PATH ?? resolve(process.cwd(), 'data', 'app.sqlite');
const runFile = resolve(process.cwd(), '.run', 'server.json');

function readJsonFile(path: string): any {
  const abs = resolve(process.cwd(), path);
  if (!existsSync(abs)) throw new AppError('NOT_FOUND', `file not found: ${abs}`, undefined, 404);
  return JSON.parse(readFileSync(abs, 'utf-8'));
}

function statusLine(label: string, value: string | number): void {
  process.stdout.write(`  ${label.padEnd(28)} ${value}\n`);
}

function snapshot(ctx: ReturnType<typeof buildContext>) {
  const count = (sql: string) => (ctx.db.prepare(sql).get() as { c: number }).c;
  return {
    instruments: count('SELECT COUNT(*) c FROM instruments'),
    quoteVersions: count('SELECT COUNT(*) c FROM quote_versions'),
    curvesOk: count("SELECT COUNT(*) c FROM curves WHERE status='OK'"),
    curvesFailed: count("SELECT COUNT(*) c FROM curves WHERE status='FAILED'"),
    reports: count('SELECT COUNT(*) c FROM reports'),
    valuations: count('SELECT COUNT(*) c FROM valuations')
  };
}

function printSnapshot(title: string, s: ReturnType<typeof snapshot>): void {
  process.stdout.write(`${title}\n`);
  statusLine('instruments', s.instruments);
  statusLine('quote versions', s.quoteVersions);
  statusLine('curves OK / FAILED', `${s.curvesOk} / ${s.curvesFailed}`);
  statusLine('frozen reports', s.reports);
  statusLine('stored valuations', s.valuations);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    usage();
    return;
  }

  if (cmd === 'serve') {
    const port = args[0] ?? '';
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', resolve(import.meta.dirname, '..', 'server-main.ts')],
      {
        env: { ...process.env, ...(port ? { PORT: port } : {}) },
        stdio: 'ignore',
        detached: true
      }
    );
    child.unref();
    process.stdout.write(`started server process ${child.pid ?? '?'}\n`);
    return;
  }

  if (cmd === 'stop') {
    if (!existsSync(runFile)) {
      process.stdout.write('no running project server recorded (.run/server.json missing)\n');
      return;
    }
    const info = JSON.parse(readFileSync(runFile, 'utf-8')) as { pid: number };
    let targetPid: number | undefined = info.pid;
    try {
      // Does not kill: throws if the pid is not alive.
      process.kill(info.pid, 0);
    } catch {
      targetPid = undefined;
    }
    if (targetPid === undefined) {
      rmSync(runFile, { force: true });
      process.stdout.write(`project server pid ${info.pid} already stopped; removed stale run file\n`);
      return;
    }
    // On Windows SIGTERM terminates without running Node close hooks, so the
    // run file is removed HERE. Only the pid recorded for THIS project is
    // touched; unrelated processes are never managed.
    try {
      process.kill(info.pid, 'SIGTERM');
    } catch {
      // fall through to taskkill for detached Windows processes
    }
    rmSync(runFile, { force: true });
    process.stdout.write(`stopped project server pid ${info.pid}; removed run file\n`);
    return;
  }

  const ctx = buildContext(dbPath);
  const before = snapshot(ctx);
  try {
    switch (cmd) {
      case 'init-db':
        process.stdout.write(`initialised ${dbPath}\n`);
        break;
      case 'seed-demo': {
        const seeded = seedScenario(ctx.market);
        for (const id of seeded.versionIds) void ctx.curves.buildFromQuoteVersion(id);
        process.stdout.write(`seeded valuation date ${seeded.valuationDate}, versions ${seeded.versionIds.join(', ')}\n`);
        break;
      }
      case 'import-instruments': {
        const file = args[0];
        if (!file) throw new AppError('VALIDATION_ERROR', 'file required');
        const body = readJsonFile(file);
        const list = Array.isArray(body) ? body : [body];
        for (const item of list) {
          const r = ctx.market.importInstrument(item);
          process.stdout.write(`imported ${r.isin}: ${r.cashFlowCount} flows, maturity ${r.maturityDate}\n`);
        }
        break;
      }
      case 'validate-payments': {
        const [vd, isin] = args;
        if (!vd || !isin) throw new AppError('VALIDATION_ERROR', 'valuationDate and isin required');
        const inst = ctx.market.getInstrument(isin, vd) as any;
        process.stdout.write(`payment schedule for ${isin} on ${vd}:\n`);
        for (const cf of inst.cashFlows) {
          statusLine(`${cf.date}  t=${cf.t.toFixed(6)}y`, `amount ${cf.amount}`);
        }
        statusLine('final cash flow', `${inst.maturity.amount} on ${inst.maturity.date} (must be > 0)`);
        break;
      }
      case 'create-quote-version': {
        const [label, file] = args;
        if (!label || !file) throw new AppError('VALIDATION_ERROR', 'label and file required');
        const body = readJsonFile(file);
        const vd = body.valuationDate ?? VALUATION_DATE;
        const created = ctx.market.createQuoteVersion(vd, label, body.quotes);
        process.stdout.write(`quote version ${created.id} (${created.label}), ${created.quotes.length} quotes\n`);
        break;
      }
      case 'list-versions': {
        const page = ctx.market.listQuoteVersions({ limit: 200 });
        for (const v of page.items) {
          statusLine(v.id, `${v.valuationDate} ${v.label}`);
        }
        break;
      }
      case 'build-curve': {
        const [qvId] = args;
        if (!qvId) throw new AppError('VALIDATION_ERROR', 'quoteVersionId required');
        const curve = ctx.curves.buildFromQuoteVersion(qvId);
        process.stdout.write(`curve ${curve.id} status ${curve.status}\n`);
        for (const s of curve.steps as any[]) {
          statusLine(
            `${s.isin} -> ${s.maturityDate}`,
            `df ${s.df.toFixed(8)} dirty ${s.dirtyPrice.toFixed(6)} reprice err ${s.error.toExponential(3)}`
          );
        }
        break;
      }
      case 'list-curves': {
        const page = ctx.curves.listCurves({ limit: 200 });
        for (const c of page.items) {
          statusLine(c.id, `${c.valuationDate} ${c.status} ${c.errorCode ?? ''}`);
        }
        break;
      }
      case 'show-curve': {
        const [curveId] = args;
        const curve = ctx.curves.getCurve(curveId!);
        process.stdout.write(JSON.stringify(curve, null, 2) + '\n');
        break;
      }
      case 'rates': {
        const [curveId] = args;
        const { curve } = ctx.curves.loadRuntimeCurve(curveId!);
        const d = curve.describe();
        process.stdout.write('zero-coupon rates (continuous, ACT/365F):\n');
        for (const z of d.zeros) {
          statusLine(`${z.date ?? z.t.toFixed(4)}  t=${z.t.toFixed(4)}`, `df ${z.df.toFixed(8)} z ${(z.zero * 100).toFixed(4)}%`);
        }
        process.stdout.write('interval forward rates (continuous):\n');
        for (const f of d.forwards) {
          statusLine(`[${f.t1.toFixed(4)} -> ${f.t2.toFixed(4)}]`, `f ${(f.forward * 100).toFixed(4)}%`);
        }
        break;
      }
      case 'value-bond':
      case 'dv01': {
        const [curveId, file, label] = args;
        if (!curveId || !file) throw new AppError('VALIDATION_ERROR', 'curveId and file required');
        const body = readJsonFile(file);
        const valuation = ctx.valuations.valueBond({ curveId, cashFlows: body.cashFlows, label });
        process.stdout.write(`PV ${valuation.pv.toFixed(8)}  YTM(continuous) ${(valuation.ytm * 100).toFixed(4)}%\n`);
        process.stdout.write(
          `DV01 one-sided ${valuation.dv01.dv01OneSided.toFixed(8)} central ${valuation.dv01.dv01Central.toFixed(8)} ` +
            `[parallel zero-rate +/-1bp, cash flows fixed]\n`
        );
        break;
      }
      case 'compare': {
        const [baseId, otherId, datesCsv] = args;
        if (!baseId || !otherId) throw new AppError('VALIDATION_ERROR', 'two curve ids required');
        const dates = datesCsv ? datesCsv.split(',').map((s) => s.trim()) : [];
        const cmp = ctx.valuations.compareCurves({ baseCurveId: baseId, otherCurveId: otherId, dates });
        for (const p of cmp.points) {
          statusLine(p.date, `zero shift ${(p.zeroShift * 10000).toFixed(3)} bp`);
        }
        break;
      }
      case 'freeze-report': {
        const [curveId] = args;
        const rpt = ctx.reports.freezeReport(curveId!);
        process.stdout.write(`froze report ${rpt.id} at ${rpt.frozenAt}\n`);
        break;
      }
      case 'show-report': {
        const [curveId] = args;
        process.stdout.write(JSON.stringify(ctx.reports.getReportByCurve(curveId!), null, 2) + '\n');
        break;
      }
      default:
        usage();
    }
  } finally {
    const after = snapshot(ctx);
    process.stdout.write('\n');
    printSnapshot('state BEFORE command:', before);
    printSnapshot('state AFTER command:', after);
    ctx.dbContext.close();
  }
}

main().catch((err) => {
  if (err instanceof AppError) {
    process.stderr.write(`ERROR [${err.code}] ${err.message}\n`);
    if (err.details !== undefined) process.stderr.write(JSON.stringify(err.details, null, 2) + '\n');
  } else {
    process.stderr.write(String(err?.stack ?? err) + '\n');
  }
  process.exit(1);
});
