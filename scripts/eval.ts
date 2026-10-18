import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { closePool, getPool } from "@/db/pool";
import { readExpectedCases, runEval } from "@/eval/run-eval";
import { DEFAULT_FIXTURE_ROOT } from "@/ingest/load";

// Runs every independent expected-answer case against the active build and writes a JSON report
// to eval/reports/ (gitignored). Exits non-zero if any case fails.
try {
  const report = await runEval(getPool(), await readExpectedCases(DEFAULT_FIXTURE_ROOT));
  for (const result of report.results) {
    console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.id}  (${result.outcome})`);
    for (const failure of result.failures) console.log(`        ${failure}`);
  }
  const dir = path.resolve("eval/reports");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `eval-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(file, `${JSON.stringify({ generated_at: new Date().toISOString(), ...report }, null, 2)}\n`);
  console.log(`\n${report.passed}/${report.results.length} cases passed on build ${report.build_ids.join(", ") || "none"}; report: ${path.relative(process.cwd(), file)}`);
  process.exitCode = report.failed ? 1 : 0;
} catch (error) {
  console.error(`eval failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
