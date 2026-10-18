import type pg from "pg";
import { z } from "zod";
import type { Outcome, ToolResponse } from "@/contracts/graph-tools";
import { PLAN_SCHEMA_VERSION, planJsonSchema, planSchema, type Plan, type PlanStep } from "@/contracts/planning";
import { readRegistryEntities } from "@/extract/extraction.db";
import type { TopicRegistry } from "@/ingest/registry";
import type { StructuredModel } from "@/provider/structured-model";
import { buildPlanPrompt, PLAN_PROMPT_VERSION, type PlanContext } from "@/retrieve/plan-prompt";
import { insertQaLog } from "@/retrieve/qa-log.db";
import { resolvePlan, type Candidate, type ResolvedPlan } from "@/retrieve/resolve-plan";
import { executeTool, withPinnedGraph, type GraphRequest, type RunOptions } from "@/retrieve/run-request";
import { parseInstant, toLocalTimePoint } from "@/time/company-time";

export const MAX_QUESTION_LENGTH = 500;

const instant = z.string().refine((value) => {
  try {
    parseInstant(value);
    return true;
  } catch {
    return false;
  }
}, "ISO instant with an explicit offset");

export const questionInputSchema = z.object({
  question: z.string().trim().min(3).max(MAX_QUESTION_LENGTH),
  as_of: instant.optional(),
  context: z
    .object({ project: z.string().regex(/^proj-[a-z0-9-]+$/).nullable(), topic: z.string().max(80).nullable() })
    .nullable()
    .optional(),
});
export type QuestionInput = z.infer<typeof questionInputSchema>;

export type StepResult = {
  plan_step: PlanStep;
  request: GraphRequest | null;
  outcome: Outcome;
  response: ToolResponse | null;
  notes: string[];
};

export type QuestionResult = {
  question: string;
  as_of: string;
  build_id: string | null;
  outcome: Outcome;
  clarification: { question: string; candidates: Candidate[] } | null;
  people: Candidate[];
  steps: StepResult[];
  notes: string[];
  truncated: boolean;
  planner: { model: string; served_model: string | null; prompt_version: string; schema_version: string };
  timings_ms: Record<string, number>;
  qa_log_id: number | null;
};

export type AskDependencies = RunOptions & { planner: StructuredModel; topics: TopicRegistry; timezone: string };

// Question -> one planning call -> deterministic resolution -> at most three fixed graph tools on
// one pinned build. Without a valid plan nothing is answered.
export async function askQuestion(pool: pg.Pool, rawInput: unknown, deps: AskDependencies): Promise<QuestionResult> {
  const input = questionInputSchema.parse(rawInput);
  const started = Date.now();
  const asOf = input.as_of ? parseInstant(input.as_of) : new Date();
  const context: PlanContext | null = input.context ?? null;
  const planner = { model: deps.planner.id, served_model: null as string | null, prompt_version: PLAN_PROMPT_VERSION, schema_version: PLAN_SCHEMA_VERSION };
  const result: QuestionResult = {
    question: input.question,
    as_of: asOf.toISOString(),
    build_id: null,
    outcome: "unavailable",
    clarification: null,
    people: [],
    steps: [],
    notes: [],
    truncated: false,
    planner,
    timings_ms: {},
    qa_log_id: null,
  };

  const entities = await readRegistryEntities(pool);
  const projects = entities.filter((entity) => entity.kind === "project");
  let rawPlan: string | null = null;
  let plan: Plan | undefined;
  let error: string | null = null;
  try {
    const reply = await deps.planner.complete({
      ...buildPlanPrompt(input.question, toLocalTimePoint(asOf, deps.timezone), projects, deps.topics, context),
      schemaName: "question_plan",
      schema: planJsonSchema(),
    });
    rawPlan = reply.content;
    planner.served_model = reply.servedModel;
    const parsed = planSchema.safeParse(JSON.parse(reply.content));
    if (parsed.success) plan = parsed.data;
    else error = `invalid plan: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`;
  } catch (caught) {
    error = `planning failed: ${(caught as Error).name}: ${(caught as Error).message}`;
  }
  result.timings_ms.plan = Date.now() - started;

  let resolved: ResolvedPlan | undefined;
  if (!plan) {
    result.notes.push("The question could not be planned, so nothing was looked up.");
  } else {
    resolved = resolvePlan(plan, { asOf, timezone: deps.timezone, entities, topics: deps.topics, context });
    if (resolved.kind === "clarify") {
      result.outcome = "needs_clarification";
      result.clarification = { question: resolved.question, candidates: resolved.candidates };
    } else if (resolved.kind === "no_steps") {
      result.outcome = resolved.outcome;
      result.people = resolved.people;
      result.notes.push(resolved.note);
    } else {
      result.people = resolved.people;
      result.truncated = resolved.truncated;
      if (resolved.truncated) result.notes.push("Only the first three parts of the question were looked up.");
      const graphStarted = Date.now();
      const steps = resolved.steps;
      const pinned = await withPinnedGraph(pool, deps, async (graph) => {
        const out: StepResult[] = [];
        for (const step of steps) {
          if (!step.ok) {
            out.push({ plan_step: step.step, request: null, outcome: step.outcome, response: null, notes: [step.note] });
            continue;
          }
          const response = await executeTool(pool, graph, step.request);
          out.push({ plan_step: step.step, request: step.request, outcome: response.outcome, response, notes: step.notes });
        }
        return out;
      });
      result.timings_ms.graph = Date.now() - graphStarted;
      result.build_id = pinned.buildId;
      if (pinned.ok) {
        result.steps = pinned.value;
        result.outcome = combineOutcomes(pinned.value.map((step) => step.outcome), resolved.truncated);
      } else {
        result.outcome = "unavailable";
        result.notes.push(pinned.note);
      }
    }
  }
  result.timings_ms.total = Date.now() - started;

  try {
    result.qa_log_id = await insertQaLog(pool, {
      question: input.question,
      asOf: result.as_of,
      context,
      buildId: result.build_id,
      outcome: result.outcome,
      planner,
      rawPlan,
      resolved: resolved ?? null,
      retrieved: retrievedIds(result.steps),
      answer: null,
      timingsMs: result.timings_ms,
      error,
    });
  } catch (logError) {
    // A logging failure must not hide the answer, but it must not be silent either.
    console.error(`qa_logs insert failed: ${(logError as Error).message}`);
  }
  return result;
}

const PRECEDENCE: Outcome[] = ["unavailable", "needs_clarification", "conflicting_evidence"];

// unavailable > needs_clarification > conflicting_evidence > all insufficient > partial > answered.
export function combineOutcomes(outcomes: Outcome[], truncated: boolean): Outcome {
  for (const outcome of PRECEDENCE) if (outcomes.includes(outcome)) return outcome;
  if (!outcomes.length || outcomes.every((outcome) => outcome === "insufficient_evidence")) return "insufficient_evidence";
  if (outcomes.some((outcome) => outcome === "insufficient_evidence" || outcome === "partial") || truncated) return "partial";
  return "answered";
}

function retrievedIds(steps: StepResult[]): { claim_ids: string[]; chunk_ids: string[] } {
  const claims = new Set<string>();
  const chunks = new Set<string>();
  for (const step of steps) {
    for (const source of step.response?.sources ?? []) {
      chunks.add(source.chunk_id);
      for (const excerpt of source.excerpts) claims.add(excerpt.claim_id);
    }
  }
  return { claim_ids: [...claims].sort(), chunk_ids: [...chunks].sort() };
}
