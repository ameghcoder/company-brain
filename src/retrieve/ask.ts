import type pg from "pg";
import { z } from "zod";
import { buildEvidencePacket, type EvidencePacket } from "@/answer/evidence-packet";
import { generateAnswer, type GeneratedAnswer } from "@/answer/generate";
import type { Outcome, SearchFacts, ToolResponse } from "@/contracts/graph-tools";
import { PLAN_SCHEMA_VERSION, planJsonSchema, planSchema, type Plan, type PlanStep } from "@/contracts/planning";
import { readRegistryEntities } from "@/extract/extraction.db";
import type { TopicRegistry } from "@/ingest/registry";
import type { StructuredModel } from "@/provider/structured-model";
import { buildPlanPrompt, PLAN_PROMPT_VERSION, type PlanContext } from "@/retrieve/plan-prompt";
import { insertQaLog } from "@/retrieve/qa-log.db";
import { resolvePlan, resolveTime, type Candidate, type ResolvedPlan } from "@/retrieve/resolve-plan";
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
  // The search that chose this step's topic, when the question named no registered topic.
  search?: ToolResponse;
};

// Graph-tool calls per question, searches included.
export const MAX_TOOL_CALLS = 3;

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
  // Internal: the facts the answer may state. The public response exposes only cited parts.
  packet: EvidencePacket | null;
  answer: GeneratedAnswer | null;
};

// Without an answerer the answer is the deterministic rendering of the packet.
export type AskDependencies = RunOptions & { planner: StructuredModel; answerer?: StructuredModel | null; topics: TopicRegistry; timezone: string };

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
    packet: null,
    answer: null,
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
      let clarification: QuestionResult["clarification"] = null;
      // Same conversion as resolvePlan: "on D" = end of D, ranges use their last moment.
      const instantFor = (planStep: PlanStep): string => {
        try {
          const window = resolveTime(planStep.time, { asOf, timezone: deps.timezone });
          return (window.at ?? (window.to ? new Date(window.to.getTime() - 1) : asOf)).toISOString();
        } catch {
          return asOf.toISOString();
        }
      };
      const nameOf = (id: string) => entities.find((entity) => entity.id === id)?.name ?? id;
      let overBudget = false;
      const pinned = await withPinnedGraph(pool, deps, async (graph) => {
        const out: StepResult[] = [];
        let calls = 0;
        const run = async (request: GraphRequest) => {
          calls++;
          return executeTool(pool, graph, request);
        };
        for (const step of steps) {
          if (calls >= MAX_TOOL_CALLS && (step.ok || step.search)) {
            overBudget = true;
            out.push({ plan_step: step.step, request: null, outcome: "insufficient_evidence", response: null, notes: [`Not looked up: at most ${MAX_TOOL_CALLS} graph tool calls run per question.`] });
            continue;
          }
          if (step.ok) {
            const response = await run(step.request);
            out.push({ plan_step: step.step, request: step.request, outcome: response.outcome, response, notes: step.notes });
            continue;
          }
          if (!step.search) {
            out.push({ plan_step: step.step, request: null, outcome: step.outcome, response: null, notes: [step.note] });
            continue;
          }
          // The subject matched no registered topic: search the records for which topic is meant.
          const { project, subject } = step.search;
          const search = await run({ intent: "search", text: subject, ...(project ? { project } : {}) });
          const wanted = step.step.intent === "owner" ? "ownership" : "decision";
          const candidates = ((search.facts as SearchFacts | null)?.topics ?? []).filter((topic) => topic.kind === wanted && topicLabel(deps.topics, topic) !== null);
          const incomplete = (search.facts as SearchFacts | null)?.incomplete ?? [];
          if (candidates.length > 1) {
            clarification = {
              question: `"${subject}" comes up in several recorded topics: ${candidates.map((topic) => `${nameOf(topic.project_id)} ${topicLabel(deps.topics, topic)}`).join("; ")}. Which one do you mean?`,
              candidates: candidates.map((topic) => ({ id: `${topic.project_id}/${topic.topic}`, name: `${nameOf(topic.project_id)}: ${topicLabel(deps.topics, topic)}`, kind: "topic" })),
            };
            out.push({ plan_step: step.step, request: null, outcome: "needs_clarification", response: null, notes: [], search });
            continue;
          }
          const match = candidates[0];
          if (!match || calls >= MAX_TOOL_CALLS) {
            const note = match
              ? `Not looked up: at most ${MAX_TOOL_CALLS} graph tool calls run per question.`
              : `${step.note} A search of the records for "${subject}" found nothing related${incomplete.length ? " (the search was incomplete)" : ""}.`;
            if (match) overBudget = true;
            out.push({ plan_step: step.step, request: null, outcome: "insufficient_evidence", response: null, notes: [note], search });
            continue;
          }
          const at = instantFor(step.step);
          const request: GraphRequest =
            step.step.intent === "owner"
              ? { intent: "owner", project: match.project_id, role: match.topic, at }
              : { intent: "explain", project: match.project_id, topic: match.topic, at };
          const response = await run(request);
          out.push({
            plan_step: step.step,
            request,
            outcome: response.outcome,
            response,
            notes: [`Matched "${subject}" to ${nameOf(match.project_id)} ${topicLabel(deps.topics, match)} by searching the records.`],
            search,
          });
        }
        return out;
      });
      if (overBudget) {
        result.truncated = true;
        result.notes.push(`Only ${MAX_TOOL_CALLS} graph tool calls run per question.`);
      }
      result.timings_ms.graph = Date.now() - graphStarted;
      result.build_id = pinned.buildId;
      if (pinned.ok) {
        result.steps = pinned.value;
        result.outcome = combineOutcomes(pinned.value.map((step) => step.outcome), result.truncated);
        if (clarification) result.clarification = clarification;
        if (result.outcome !== "unavailable" && result.outcome !== "needs_clarification") {
          const answerStarted = Date.now();
          result.packet = buildEvidencePacket({
            question: input.question,
            asOfLocal: toLocalTimePoint(asOf, deps.timezone).value,
            buildId: result.build_id,
            steps: result.steps,
            names: new Map(entities.map((entity) => [entity.id, entity.name])),
            timezone: deps.timezone,
          });
          result.answer = await generateAnswer(result.packet, deps.answerer ?? null, entities);
          result.timings_ms.answer = Date.now() - answerStarted;
        }
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
      answer: result.answer && result.packet
        ? {
            source: result.answer.source,
            prompt_version: result.answer.prompt_version,
            schema_version: result.answer.schema_version,
            attempts: result.answer.attempts,
            items: result.answer.answer.items,
            packet: { fact_ids: result.packet.facts.map((fact) => fact.fact_id), citation_ids: result.packet.citations.map((c) => c.citation_id), truncated: result.packet.truncated },
          }
        : null,
      timingsMs: result.timings_ms,
      error,
    });
  } catch (logError) {
    // A logging failure must not hide the answer, but it must not be silent either.
    console.error(`qa_logs insert failed: ${(logError as Error).message}`);
  }
  return result;
}

function topicLabel(topics: TopicRegistry, topic: { project_id: string; topic: string; kind: string }): string | null {
  const registry = topics.projects[topic.project_id];
  if (topic.kind === "ownership") return registry?.ownership_roles[topic.topic]?.label ?? null;
  return registry?.decision_topics[topic.topic] ?? null;
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
