import { readFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { compareCase, type CaseResult, type ExpectedCase } from "@/eval/compare";
import { runRequest, type RunOptions } from "@/retrieve/run-request";

export type EvalReport = { build_ids: string[]; passed: number; failed: number; results: CaseResult[] };

export async function readExpectedCases(fixtureRoot: string): Promise<ExpectedCase[]> {
  const raw = JSON.parse(await readFile(path.join(fixtureRoot, "expected/answers.json"), "utf8")) as { cases: ExpectedCase[] };
  return raw.cases;
}

export async function runEval(pool: pg.Pool, cases: ExpectedCase[], options: RunOptions = {}): Promise<EvalReport> {
  const results: CaseResult[] = [];
  const builds = new Set<string>();
  for (const expected of cases.filter((item) => !item.nl_only)) {
    const response = await runRequest(pool, expected.request, options);
    if (response.build_id) builds.add(response.build_id);
    results.push(compareCase(expected, response));
  }
  const passed = results.filter((result) => result.ok).length;
  return { build_ids: [...builds], passed, failed: results.length - passed, results };
}
