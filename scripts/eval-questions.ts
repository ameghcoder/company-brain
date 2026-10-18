import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { closePool, getPool } from "@/db/pool";
import { compareQuestion, type QuestionCase } from "@/eval/compare-question";
import { readExpectedCases } from "@/eval/run-eval";
import { DEFAULT_FIXTURE_ROOT } from "@/ingest/load";
import { checkAnswer } from "@/answer/check-answer";
import { readRegistryEntities } from "@/extract/extraction.db";
import { askQuestion } from "@/retrieve/ask";
import { liveQuestionDependencies } from "@/retrieve/question-deps";

// PAID: asks every hand-written question with the real planner against the active build and
// compares the results with the independent expectations. Writes eval/reports/questions-*.json.
try {
  const raw = JSON.parse(await readFile(path.join(DEFAULT_FIXTURE_ROOT, "expected/questions.json"), "utf8")) as { questions: QuestionCase[] };
  const answers = JSON.parse(await readFile(path.join(DEFAULT_FIXTURE_ROOT, "expected/answers.json"), "utf8")) as { as_of: string };
  const cases = new Map((await readExpectedCases(DEFAULT_FIXTURE_ROOT)).map((item) => [item.id, item]));
  const deps = await liveQuestionDependencies();
  const registry = await readRegistryEntities(getPool());
  const sources: Record<string, number> = {};
  const rows = [];
  for (const nl of raw.questions) {
    const expected = cases.get(nl.case_id);
    if (!expected) throw new Error(`questions.json refers to unknown case ${nl.case_id}`);
    const result = await askQuestion(getPool(), { question: nl.question, as_of: answers.as_of, context: nl.context ?? null }, deps);
    const compared = compareQuestion(expected, nl, result);
    // The final answer, whatever its source, must pass the server checks.
    if (result.answer && result.packet) {
      sources[result.answer.source] = (sources[result.answer.source] ?? 0) + 1;
      const failures = checkAnswer(result.answer.answer, result.packet, registry);
      if (failures.length) compared.failures.push(...failures.map((failure) => `final answer: ${failure}`));
      compared.ok = compared.failures.length === 0;
    }
    rows.push({ ...compared, answer_source: result.answer?.source ?? null, answer_attempts: result.answer?.attempts ?? [], answer: result.answer?.answer.items.map((item) => item.text) ?? [], requests: result.steps.map((step) => step.request), clarification: result.clarification, notes: result.notes, timings_ms: result.timings_ms, qa_log_id: result.qa_log_id });
    console.log(`${compared.ok ? "PASS" : "FAIL"}  ${nl.case_id}  (${result.outcome}, answer ${result.answer?.source ?? "none"}, ${result.timings_ms.total} ms)`);
    for (const failure of compared.failures) console.log(`        ${failure}`);
  }
  const passed = rows.filter((row) => row.ok).length;
  const dir = path.resolve("eval/reports");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `questions-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(file, `${JSON.stringify({ generated_at: new Date().toISOString(), planner: deps.planner.id, passed, total: rows.length, answer_sources: sources, rows }, null, 2)}\n`);
  console.log(`\n${passed}/${rows.length} questions passed; answer sources ${JSON.stringify(sources)}; report: ${path.relative(process.cwd(), file)}`);
  process.exitCode = passed === rows.length ? 0 : 1;
} catch (error) {
  console.error(`eval:questions failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
