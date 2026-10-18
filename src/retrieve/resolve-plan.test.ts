import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Plan, PlanStep } from "@/contracts/planning";
import type { TopicRegistry } from "@/ingest/registry";
import { resolvePlan, resolveTime, type RegistryEntity, type ResolveContext } from "@/retrieve/resolve-plan";
import { parseInstant } from "@/time/company-time";

const TZ = "America/New_York";
const entities: RegistryEntity[] = [
  { id: "proj-atlas", kind: "project", name: "Atlas", aliases: ["Project Atlas"] },
  { id: "proj-beacon", kind: "project", name: "Beacon", aliases: ["Beacon app"] },
  { id: "p-alex-chen", kind: "person", name: "Alex Chen", aliases: ["Alex"] },
  { id: "p-alex-rivera", kind: "person", name: "Alex Rivera", aliases: ["Alex"] },
  { id: "p-marcus-lee", kind: "person", name: "Marcus Lee", aliases: ["Marcus"] },
];
const topics: TopicRegistry = {
  revision: 1,
  projects: {
    "proj-atlas": { decision_topics: { "payments.provider": "Payments provider" }, ownership_roles: { "migration.owner": { label: "Migration owner", exclusive: true } } },
    "proj-beacon": { decision_topics: { "analytics.provider": "Analytics" }, ownership_roles: { "release.owner": { label: "Release owner", exclusive: true } } },
  },
};
const ctx: ResolveContext = { asOf: parseInstant("2026-10-18T12:00:00-04:00"), timezone: TZ, entities, topics, context: null };

const step = (fields: Partial<PlanStep>): PlanStep => ({
  intent: "explain",
  project_mention: "Atlas",
  topic: "payments.provider",
  subject: null,
  time: { kind: "now", date: null, end_date: null },
  ...fields,
});
const plan = (steps: PlanStep[], fields: Partial<Plan> = {}): Plan => ({ status: "plan", clarification: null, steps, person_mentions: [], ...fields });

function onlyRequest(resolved: ReturnType<typeof resolvePlan>) {
  assert.equal(resolved.kind, "steps");
  if (resolved.kind !== "steps") throw new Error("unreachable");
  const [first] = resolved.steps;
  assert.ok(first?.ok, JSON.stringify(first));
  if (!first?.ok) throw new Error("unreachable");
  return first.request;
}

describe("time references", () => {
  it("reads 'on D' as the end of D and 'before D' as just before D, across the DST change", () => {
    assert.equal(resolveTime({ kind: "on_date", date: "2026-10-05", end_date: null }, ctx).at?.toISOString(), "2026-10-06T03:59:59.999Z");
    assert.equal(resolveTime({ kind: "before_date", date: "2026-10-15", end_date: null }, ctx).at?.toISOString(), "2026-10-15T03:59:59.999Z");
    assert.equal(resolveTime({ kind: "start_of_date", date: "2026-11-01", end_date: null }, ctx).at?.toISOString(), "2026-11-01T04:00:00.000Z");
    // 2026-11-01 ends after the fall-back, at 05:00Z on 11-02.
    assert.equal(resolveTime({ kind: "on_date", date: "2026-11-01", end_date: null }, ctx).at?.toISOString(), "2026-11-02T04:59:59.999Z");
  });

  it("turns a month into a half-open range", () => {
    const range = resolveTime({ kind: "date_range", date: "2026-10-01", end_date: "2026-10-31" }, ctx);
    assert.equal(range.from?.toISOString(), "2026-10-01T04:00:00.000Z");
    assert.equal(range.to?.toISOString(), "2026-11-01T04:00:00.000Z");
  });

  it("rejects malformed or inverted dates", () => {
    assert.throws(() => resolveTime({ kind: "on_date", date: "Oct 5", end_date: null }, ctx), /not a YYYY-MM-DD date/);
    assert.throws(() => resolveTime({ kind: "date_range", date: "2026-10-31", end_date: "2026-10-01" }, ctx), /ends/);
  });
});

describe("plan resolution", () => {
  it("resolves names and keys into a validated request", () => {
    assert.deepEqual(onlyRequest(resolvePlan(plan([step({ project_mention: "project atlas" })]), ctx)), {
      intent: "explain",
      project: "proj-atlas",
      topic: "payments.provider",
      at: "2026-10-18T16:00:00.000Z",
    });
  });

  it("asks which person when a name is ambiguous", () => {
    const resolved = resolvePlan(plan([], { person_mentions: ["Alex"] }), ctx);
    assert.equal(resolved.kind, "clarify");
    assert.deepEqual(resolved.kind === "clarify" && resolved.candidates.map((c) => c.id), ["p-alex-chen", "p-alex-rivera"]);
  });

  it("accepts a project ID from the allowed list as the project mention", () => {
    assert.equal(onlyRequest(resolvePlan(plan([step({ project_mention: "proj-atlas" })]), ctx)).project, "proj-atlas");
  });

  it("prefers the registry's clarification over the planner's when a person is ambiguous", () => {
    const resolved = resolvePlan(plan([], { status: "clarify", clarification: "Which decision?", person_mentions: ["Alex"] }), ctx);
    assert.ok(resolved.kind === "clarify" && resolved.candidates.length === 2, JSON.stringify(resolved));
  });

  it("reports an unknown project or subject as insufficient evidence", () => {
    const unknown = resolvePlan(plan([step({ project_mention: "Zephyr" })]), ctx);
    assert.ok(unknown.kind === "steps" && !unknown.steps[0]?.ok && unknown.steps[0]?.outcome === "insufficient_evidence");
    const subject = resolvePlan(plan([step({ project_mention: null, topic: null, subject: "CRM vendor" })]), ctx);
    assert.ok(subject.kind === "steps" && !subject.steps[0]?.ok && /Nothing about "CRM vendor"/.test(subject.steps[0]?.note ?? ""));
  });

  it("never uses a topic key outside the project's registry", () => {
    const invented = resolvePlan(plan([step({ topic: "payments.crm" })]), ctx);
    assert.ok(invented.kind === "steps" && !invented.steps[0]?.ok && invented.steps[0]?.outcome === "insufficient_evidence");
    const wrongProject = resolvePlan(plan([step({ topic: "analytics.provider" })]), ctx);
    assert.ok(wrongProject.kind === "steps" && !wrongProject.steps[0]?.ok);
  });

  it("finds the project from a topic key unique to one project", () => {
    const request = onlyRequest(resolvePlan(plan([step({ intent: "owner", project_mention: null, topic: "release.owner" })]), ctx));
    assert.equal(request.project, "proj-beacon");
  });

  it("uses follow-up context only when the question names no project", () => {
    const followUp = resolvePlan(plan([step({ project_mention: null, topic: null })]), { ...ctx, context: { project: "proj-atlas", topic: "payments.provider" } });
    assert.equal(onlyRequest(followUp).project, "proj-atlas");
  });

  it("runs at most three steps and flags the rest", () => {
    const resolved = resolvePlan(plan([step({}), step({}), step({}), step({})]), ctx);
    assert.ok(resolved.kind === "steps" && resolved.steps.length === 3 && resolved.truncated);
  });

  it("asks for a period when changes have no range", () => {
    const resolved = resolvePlan(plan([step({ intent: "changes" })]), ctx);
    assert.equal(resolved.kind, "clarify");
  });
});
