import { renderResponse } from "@/answer/render";
import { ConfigError } from "@/config/server-env";
import { closePool, getPool } from "@/db/pool";
import { askQuestion } from "@/retrieve/ask";
import { liveQuestionDependencies } from "@/retrieve/question-deps";

// Usage: tsx scripts/ask.ts "<question>" [--as-of <ISO instant>] [--json] [--steps]
// Paid: one planning call plus answer generation (and at most one repair). --steps also prints
// the verified tool results the answer was built from.
const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const question = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--as-of").join(" ");

try {
  const result = await askQuestion(getPool(), { question, ...(flag("--as-of") ? { as_of: flag("--as-of") } : {}) }, await liveQuestionDependencies());
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Q: ${result.question}`);
    console.log(`outcome: ${result.outcome}${result.build_id ? ` (build ${result.build_id})` : ""}; planner ${result.planner.served_model ?? result.planner.model}; ${result.timings_ms.total} ms; qa_log ${result.qa_log_id}`);
    if (result.clarification) console.log(`clarify: ${result.clarification.question}`);
    if (result.answer && result.packet) {
      const attempts = result.answer.attempts.map((a) => `${a.kind}:${a.error ? "error" : a.failures.length ? `${a.failures.length} failed check(s)` : "ok"}`).join(", ");
      console.log(`\nAnswer (${result.answer.source}${attempts ? `; ${attempts}` : ""}):`);
      const citations = new Map(result.packet.citations.map((c) => [c.citation_id, c]));
      for (const item of result.answer.answer.items) {
        console.log(`- ${item.text} ${item.citation_ids.map((id) => `[${citations.get(id)?.document_id ?? id}]`).join("")}`);
      }
    }
    for (const note of result.notes) console.log(`note: ${note}`);
    if (args.includes("--steps")) for (const step of result.steps) {
      console.log(`\n[${step.plan_step.intent}] ${step.request ? JSON.stringify(step.request) : "(not run)"}`);
      for (const note of step.notes) console.log(`  note: ${note}`);
      if (step.response) for (const line of renderResponse(step.response)) console.log(`  ${line}`);
    }
  }
} catch (error) {
  if (error instanceof ConfigError) {
    console.log("NOT VERIFIED  asking needs provider configuration");
    console.log(error.message);
    process.exitCode = 2;
  } else {
    console.error(`ask failed: ${(error as Error).message}`);
    process.exitCode = 1;
  }
} finally {
  await closePool();
}
