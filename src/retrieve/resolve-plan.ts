import type { Plan, PlanStep, TimeReference } from "@/contracts/planning";
import type { ToolRequest } from "@/contracts/graph-tools";
import { normalizeAlias, resolveFromMatches, type TopicRegistry } from "@/ingest/registry";
import type { PlanContext } from "@/retrieve/plan-prompt";
import { parseLocalTime } from "@/time/company-time";

// Turns a model-proposed plan into validated tool requests. Every name, key, and date the model
// produced is checked here; nothing it says is trusted as an ID, and ambiguity becomes a specific
// clarification rather than a guess.

export const MAX_STEPS = 3;

export type RegistryEntity = { id: string; kind: string; name: string; aliases: string[] };
export type Candidate = { id: string; name: string; kind: string };

export type StepResolution =
  | { ok: true; step: PlanStep; request: Exclude<ToolRequest, { intent: "resolve_alias" }>; notes: string[] }
  | { ok: false; step: PlanStep; outcome: "insufficient_evidence" | "needs_clarification"; note: string; candidates: Candidate[] };

export type ResolvedPlan =
  | { kind: "clarify"; question: string; candidates: Candidate[] }
  | { kind: "no_steps"; outcome: "insufficient_evidence"; note: string; people: Candidate[] }
  | { kind: "steps"; steps: StepResolution[]; truncated: boolean; people: Candidate[] };

export type ResolveContext = {
  asOf: Date;
  timezone: string;
  entities: RegistryEntity[];
  topics: TopicRegistry;
  context: PlanContext | null;
};

function lookup(entities: RegistryEntity[], text: string, kind: string): Candidate[] {
  const wanted = normalizeAlias(text);
  const ids = entities
    .filter((entity) => entity.kind === kind && [entity.name, ...entity.aliases].some((alias) => normalizeAlias(alias) === wanted))
    .map((entity) => entity.id);
  const resolution = resolveFromMatches(ids);
  const matched = resolution.status === "resolved" ? [resolution.entityId] : resolution.status === "ambiguous" ? resolution.candidates : [];
  return matched.map((id) => {
    const entity = entities.find((item) => item.id === id) as RegistryEntity;
    return { id: entity.id, name: entity.name, kind: entity.kind };
  });
}

export function resolvePlan(plan: Plan, ctx: ResolveContext): ResolvedPlan {
  // Registry ambiguity comes first: it yields a precise clarification with candidates, which is
  // more useful than a model-written question.
  const people: Candidate[] = [];
  for (const mention of plan.person_mentions) {
    const matches = lookup(ctx.entities, mention, "person");
    if (matches.length > 1) {
      return { kind: "clarify", question: `"${mention}" could mean ${matches.map((m) => m.name).join(" or ")}. Which one do you mean?`, candidates: matches };
    }
    if (matches[0]) people.push(matches[0]);
  }

  if (plan.status === "clarify") {
    return { kind: "clarify", question: plan.clarification?.trim() || "Could you say which project, topic, or time you mean?", candidates: [] };
  }

  if (plan.status === "out_of_scope") {
    return { kind: "no_steps", outcome: "insufficient_evidence", note: "This assistant answers questions about recorded project decisions and ownership only.", people };
  }
  if (!plan.steps.length) {
    const note = people.length
      ? `Questions about what ${people.map((p) => p.name).join(" and ")} did across projects are not supported yet; ask about a project or role.`
      : "The question does not name anything the records can answer.";
    return { kind: "no_steps", outcome: "insufficient_evidence", note, people };
  }

  const steps = plan.steps.slice(0, MAX_STEPS).map((step) => resolveStep(step, ctx));
  const clarification = steps.find((step) => !step.ok && step.outcome === "needs_clarification");
  if (clarification && !clarification.ok) return { kind: "clarify", question: clarification.note, candidates: clarification.candidates };
  return { kind: "steps", steps, truncated: plan.steps.length > MAX_STEPS, people };
}

function resolveStep(step: PlanStep, ctx: ResolveContext): StepResolution {
  const notes: string[] = [];
  const fail = (outcome: "insufficient_evidence" | "needs_clarification", note: string, candidates: Candidate[] = []): StepResolution => ({
    ok: false,
    step,
    outcome,
    note,
    candidates,
  });
  const keysOf = (projectId: string) => {
    const registry = ctx.topics.projects[projectId];
    return step.intent === "owner"
      ? Object.keys(registry?.ownership_roles ?? {})
      : step.intent === "explain"
        ? Object.keys(registry?.decision_topics ?? {})
        : [...Object.keys(registry?.decision_topics ?? {}), ...Object.keys(registry?.ownership_roles ?? {})];
  };

  // Project: an exact alias match, the context of a follow-up, or the one project owning the topic.
  let projectId: string | null = null;
  if (step.project_mention) {
    // The planner may name a project by the ID it was shown; anything else goes through the aliases.
    const byId = ctx.entities.find((entity) => entity.kind === "project" && entity.id === step.project_mention);
    const matches = byId ? [{ id: byId.id, name: byId.name, kind: byId.kind }] : lookup(ctx.entities, step.project_mention, "project");
    if (matches.length > 1) return fail("needs_clarification", `"${step.project_mention}" could mean ${matches.map((m) => m.name).join(" or ")}. Which project?`, matches);
    if (!matches[0]) return fail("insufficient_evidence", `No project called "${step.project_mention}" is recorded.`);
    projectId = matches[0].id;
  } else if (step.topic) {
    const owners = Object.keys(ctx.topics.projects).filter((id) => keysOf(id).includes(step.topic as string));
    if (owners.length === 1) projectId = owners[0] ?? null;
    else if (owners.length > 1) {
      const candidates = owners.map((id) => ({ id, name: ctx.entities.find((e) => e.id === id)?.name ?? id, kind: "project" }));
      return fail("needs_clarification", `Several projects record ${step.topic}: ${candidates.map((c) => c.name).join(", ")}. Which one?`, candidates);
    }
  }
  if (!projectId && ctx.context?.project) projectId = ctx.context.project;
  if (!projectId) {
    if (step.subject && !step.topic) return fail("insufficient_evidence", `Nothing about "${step.subject}" is recorded for any project.`);
    return fail("needs_clarification", "Which project do you mean?");
  }

  // Topic: only keys from this project's registry are ever used.
  let topic = step.topic;
  if (topic && !keysOf(projectId).includes(topic)) {
    notes.push(`Ignored topic "${topic}", which is not recorded for ${projectId}.`);
    topic = null;
  }
  if (!topic && ctx.context?.topic && ctx.context.project === projectId && keysOf(projectId).includes(ctx.context.topic)) {
    topic = ctx.context.topic;
  }
  if (!topic && (step.intent === "owner" || step.intent === "explain")) {
    const what = step.subject ? `"${step.subject}"` : "that subject";
    return fail("insufficient_evidence", `Nothing about ${what} is recorded for ${projectId}.`);
  }

  let window: { at?: Date; from?: Date; to?: Date };
  try {
    window = resolveTime(step.time, ctx);
  } catch (error) {
    return fail("needs_clarification", `I could not read the date in the question (${(error as Error).message}). Which date do you mean?`);
  }

  switch (step.intent) {
    case "owner":
    case "explain": {
      let at = window.at;
      if (!at && window.to) {
        at = new Date(window.to.getTime() - 1);
        notes.push("Used the end of the requested period.");
      }
      at ??= ctx.asOf;
      const base = { project: projectId, at: at.toISOString() };
      const request = step.intent === "owner" ? { intent: "owner" as const, ...base, role: topic as string } : { intent: "explain" as const, ...base, topic: topic as string };
      return { ok: true, step, request, notes };
    }
    case "changes": {
      let { from, to } = window;
      if (!from || !to) {
        if (step.time.kind !== "on_date" || !step.time.date) return fail("needs_clarification", "For which period do you want the changes?");
        // "What changed on D": the changes that took effect during D.
        from = startOf(step.time.date, ctx.timezone);
        to = startOf(nextDay(step.time.date), ctx.timezone);
      }
      return { ok: true, step, request: { intent: "changes", project: projectId, ...(topic ? { topic } : {}), from: from.toISOString(), to: to.toISOString() }, notes };
    }
    case "timeline":
      return {
        ok: true,
        step,
        request: {
          intent: "timeline",
          project: projectId,
          ...(topic ? { topic } : {}),
          ...(window.from ? { from: window.from.toISOString() } : {}),
          ...(window.to ? { to: window.to.toISOString() } : {}),
        },
        notes,
      };
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function dayString(value: string): string {
  if (!DAY.test(value)) throw new Error(`"${value}" is not a YYYY-MM-DD date`);
  return value;
}

function startOf(day: string, timezone: string): Date {
  return new Date(parseLocalTime(day, timezone).utc);
}

function nextDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

// Converts a time reference into instants in the company timezone. "On D" means the state in
// effect at the end of D; "before D" means just before D starts.
export function resolveTime(time: TimeReference, ctx: Pick<ResolveContext, "asOf" | "timezone">): { at?: Date; from?: Date; to?: Date } {
  switch (time.kind) {
    case "now":
      return { at: ctx.asOf };
    case "all_time":
      return {};
    case "on_date":
      return { at: new Date(startOf(nextDay(dayString(time.date ?? "")), ctx.timezone).getTime() - 1) };
    case "before_date":
      return { at: new Date(startOf(dayString(time.date ?? ""), ctx.timezone).getTime() - 1) };
    case "start_of_date":
      return { at: startOf(dayString(time.date ?? ""), ctx.timezone) };
    case "date_range": {
      const first = dayString(time.date ?? "");
      const last = dayString(time.end_date ?? time.date ?? "");
      if (last < first) throw new Error(`the range ends (${last}) before it starts (${first})`);
      return { from: startOf(first, ctx.timezone), to: startOf(nextDay(last), ctx.timezone) };
    }
  }
}
