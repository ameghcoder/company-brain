import { renderResponse } from "@/answer/render";
import { closePool, getPool } from "@/db/pool";
import { readExpectedCases } from "@/eval/run-eval";
import { DEFAULT_FIXTURE_ROOT } from "@/ingest/load";
import { runRequest } from "@/retrieve/run-request";

// Runs the demo questions as structured requests (no LLM planning yet) against the active build
// and prints deterministic answers with evidence. Uses only each case's request, never its answer.
const DEMO_CASES = ["q1-atlas-provider-changes-this-month", "q2-why-provider-replaced", "q3a-migration-owner-today", "q3b-migration-owner-before-oct-15", "q4-atlas-timeline", "q5-absent-subject", "alias-alex-is-ambiguous"];

try {
  const cases = (await readExpectedCases(DEFAULT_FIXTURE_ROOT)).filter((item) => DEMO_CASES.includes(item.id));
  for (const item of cases) {
    console.log(`\nQ: ${item.question}`);
    console.log(`   request: ${JSON.stringify(item.request)}`);
    for (const line of renderResponse(await runRequest(getPool(), item.request))) console.log(`   ${line}`);
  }
} catch (error) {
  console.error(`demo failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
