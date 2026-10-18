import { answerJsonSchema, answerSchema, ANSWER_SCHEMA_VERSION, type Answer } from "@/contracts/answer";
import { buildAnswerPrompt, buildRepairPrompt, ANSWER_PROMPT_VERSION } from "@/answer/answer-prompt";
import { checkAnswer, type NamedEntity } from "@/answer/check-answer";
import type { EvidencePacket } from "@/answer/evidence-packet";
import { deterministicAnswer } from "@/answer/fallback";
import type { StructuredModel } from "@/provider/structured-model";

// The repair step is capped here, in code: one generation plus at most one repair.
export const MAX_REPAIRS = 1;

export type AnswerAttempt = { kind: "generate" | "repair"; served_model: string | null; failures: string[]; error: string | null };

export type GeneratedAnswer = {
  source: "model" | "repaired" | "deterministic";
  answer: Answer;
  attempts: AnswerAttempt[];
  prompt_version: string;
  schema_version: string;
};

export async function generateAnswer(packet: EvidencePacket, model: StructuredModel | null, registry: NamedEntity[]): Promise<GeneratedAnswer> {
  const attempts: AnswerAttempt[] = [];
  const result = (source: GeneratedAnswer["source"], answer: Answer): GeneratedAnswer => ({
    source,
    answer,
    attempts,
    prompt_version: ANSWER_PROMPT_VERSION,
    schema_version: ANSWER_SCHEMA_VERSION,
  });
  if (!model) return result("deterministic", deterministicAnswer(packet));

  let previous: Answer | null = null;
  let failures: string[] = [];
  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
    const kind = attempt === 0 ? "generate" : "repair";
    const prompt = attempt === 0 ? buildAnswerPrompt(packet) : buildRepairPrompt(packet, previous, failures);
    let servedModel: string | null = null;
    try {
      const reply = await model.complete({ ...prompt, schemaName: "answer", schema: answerJsonSchema() });
      servedModel = reply.servedModel;
      const parsed = answerSchema.safeParse(JSON.parse(reply.content));
      if (!parsed.success) {
        failures = [`the answer did not match the schema: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`];
        attempts.push({ kind, served_model: servedModel, failures, error: null });
        continue;
      }
      previous = parsed.data;
      failures = checkAnswer(parsed.data, packet, registry);
      attempts.push({ kind, served_model: servedModel, failures, error: null });
      if (!failures.length) return result(attempt === 0 ? "model" : "repaired", parsed.data);
    } catch (error) {
      // A provider failure is not repaired; the verified rendering is returned instead.
      attempts.push({ kind, served_model: servedModel, failures: [], error: `${(error as Error).name}: ${(error as Error).message}` });
      break;
    }
  }
  return result("deterministic", deterministicAnswer(packet));
}
