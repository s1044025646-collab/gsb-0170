import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildContext } from './app-context.js';
import { seedScenario } from './data/seed.js';

/**
 * Repeatable end-to-end demo against a throwaway DB in .tmp/demo.sqlite.
 * Prints: bootstrap repricing errors, zero/forward rates, a new-bond
 * valuation, DV01, version comparison and a frozen report.
 */
function main(): void {
  const dbPath = resolve(process.cwd(), '.tmp', 'demo.sqlite');
  rmSync(dbPath, { force: true });
  for (const suffix of ['-wal', '-shm']) rmSync(dbPath + suffix, { force: true });

  const ctx = buildContext(dbPath);
  const { versionIds } = seedScenario(ctx.market);

  const curves = versionIds.map((id) => ctx.curves.buildFromQuoteVersion(id));

  for (const c of curves) {
    process.stdout.write(`\n=== curve ${c.id} (${c.status}) ===\n`);
    for (const step of c.steps as any[]) {
      process.stdout.write(
        `  ${step.isin.padEnd(9)} ${step.maturityDate} df=${step.df.toFixed(10)} ` +
          `dirty=${step.dirtyPrice.toFixed(8)} repriceErr=${step.error.toExponential(3)}\n`
      );
    }
    const { curve } = ctx.curves.loadRuntimeCurve(c.id);
    const described = curve.describe();
    for (const z of described.zeros) {
      process.stdout.write(`  zero ${z.date}: ${(z.zero * 100).toFixed(4)}%\n`);
    }
    for (const f of described.forwards) {
      process.stdout.write(`  fwd [${f.t1.toFixed(2)},${f.t2.toFixed(2)}]: ${(f.forward * 100).toFixed(4)}%\n`);
    }
  }

  const valuation = ctx.valuations.valueBond({
    curveId: curves[0]!.id,
    label: 'new-2.5y-6pct-bond',
    cashFlows: [
      { date: '2027-03-31', amount: 3 },
      { date: '2027-09-30', amount: 3 },
      { date: '2028-09-30', amount: 3 },
      { date: '2029-03-31', amount: 103 }
    ]
  });
  process.stdout.write(`\nnew bond PV=${valuation.pv.toFixed(8)} YTM=${(valuation.ytm * 100).toFixed(4)}%\n`);
  process.stdout.write(
    `DV01 oneSided=${valuation.dv01.dv01OneSided.toFixed(8)} central=${valuation.dv01.dv01Central.toFixed(8)} ` +
      `(parallel zero-rate bump, flows fixed)\n`
  );

  const cmp = ctx.valuations.compareCurves({
    baseCurveId: curves[0]!.id,
    otherCurveId: curves[1]!.id,
    dates: ['2027-09-30', '2028-09-30', '2029-09-30']
  });
  process.stdout.write('\nversion comparison (zero shift, bp):\n');
  for (const p of cmp.points) {
    process.stdout.write(`  ${p.date}: ${(p.zeroShift * 10000).toFixed(3)} bp\n`);
  }

  const report = ctx.reports.freezeReport(curves[0]!.id);
  process.stdout.write(`\nfroze report ${report.id} preserving ${report.quoteVersion.quotes.length} original quotes\n`);

  ctx.dbContext.close();
  process.stdout.write(`\ndemo db kept at ${dbPath} (inside project; delete .tmp to clean)\n`);
}

main();
