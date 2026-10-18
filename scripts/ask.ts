import { renderResponse } from "@/answer/render";
import { ConfigError } from "@/config/server-env";
import { closePool, getPool } from "@/db/pool";
import { askQuestion } from "@/retrieve/ask";
import { liveQuestionDependencies } from "@/retrieve/question-deps";

// Usage: tsx scripts/ask.ts "<question>" [--as-of <ISO instant>] [--json]
// One paid planning call; the answer is the deterministic rendering of verified tool results.
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
    for (const note of result.notes) console.log(`note: ${note}`);
    for (const step of result.steps) {
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
