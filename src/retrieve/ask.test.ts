import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { FalkorDB } from "falkordb";
import type pg from "pg";
import type { Plan, PlanStep } from "@/contracts/planning";
import { closePool } from "@/db/pool";
import { publishGraph } from "@/graph/activate";
import { connectFalkorDB } from "@/graph/client";
import { DEFAULT_FIXTURE_ROOT, loadFixtures } from "@/ingest/load";
import { loadManifest } from "@/ingest/manifest";
import { readTopicRegistry, type TopicRegistry } from "@/ingest/registry";
import type { StructuredModel } from "@/provider/structured-model";
import { askQuestion, combineOutcomes } from "@/retrieve/ask";
import { deleteTestGraphs, useFreshTestDatabase, useTestGraphs } from "@/test-support/test-db";

// SCRIPTED PLANNER DOUBLE: returns a fixed plan so these tests exercise our resolution, pinning,
// outcome, and logging code. Real planning quality is measured by `pnpm eval:questions`.
function scriptedPlanner(reply: Plan | string | Error): StructuredModel & { calls: number } {
  const planner = {
    id: "planner-test-double",
    calls: 0,
    async complete() {
      planner.calls++;
      if (reply instanceof Error) throw reply;
      return { content: typeof reply === "string" ? reply : JSON.stringify(reply), servedModel: "planner-test-double" };
    },
  };
  return planner;
}

const AS_OF = "2026-10-18T12:00:00-04:00";
const step = (fields: Partial<PlanStep>): PlanStep => ({
  intent: "owner",
  project_mention: "proj-atlas",
  topic: "migration.owner",
  subject: null,
  time: { kind: "now", date: null, end_date: null },
  ...fields,
});
const plan = (steps: PlanStep[], fields: Partial<Plan> = {}): Plan => ({ status: "plan", clarification: null, steps, person_mentions: [], ...fields });

describe("question pipeline with a scripted planner (real Postgres + FalkorDB)", () => {
  let pool: pg.Pool;
  let db: FalkorDB;
  let topics: TopicRegistry;
  const deps = (planner: StructuredModel) => ({ planner, topics, timezone: "America/New_York" });
  const logCount = async () => Number((await pool.query("SELECT count(*) FROM qa_logs")).rows[0].count);

  before(async () => {
    pool = await useFreshTestDatabase();
    db = await connectFalkorDB();
    await useTestGraphs(db);
    await loadFixtures(pool);
    topics = await readTopicRegistry(await loadManifest(DEFAULT_FIXTURE_ROOT));
    assert.equal((await publishGraph(pool, db, topics)).activated, true);
  });
  after(async () => {
    await deleteTestGraphs(db);
    await db.close();
    await closePool();
  });

  it("answers a multi-step question from one pinned build and logs it", async () => {
    const before = await logCount();
    const result = await askQuestion(
      pool,
      { question: "Who owns the Atlas migration, and what is its payments provider?", as_of: AS_OF },
      deps(scriptedPlanner(plan([step({}), step({ intent: "explain", topic: "payments.provider" })]))),
    );
    assert.equal(result.outcome, "answered");
    assert.equal(result.steps.length, 2);
    assert.ok(result.build_id);
    for (const item of result.steps) assert.equal(item.response?.build_id, result.build_id);
    assert.equal(await logCount(), before + 1);
    const logged = await pool.query("SELECT outcome, build_id, retrieved FROM qa_logs WHERE qa_log_id = $1", [result.qa_log_id]);
    assert.equal(logged.rows[0].outcome, "answered");
    assert.ok(logged.rows[0].retrieved.claim_ids.includes("own-atlas-migration-marcus"));
  });

  it("answers nothing without a valid plan", async () => {
    for (const reply of ['{"status": "plan"}', "not json", new Error("connect ECONNRESET")]) {
      const result = await askQuestion(pool, { question: "Who owns the Atlas migration?", as_of: AS_OF }, deps(scriptedPlanner(reply)));
      assert.equal(result.outcome, "unavailable");
      assert.deepEqual(result.steps, []);
      const logged = await pool.query("SELECT error, raw_plan FROM qa_logs WHERE qa_log_id = $1", [result.qa_log_id]);
      assert.match(logged.rows[0].error, /invalid plan|planning failed/);
    }
  });

  it("asks which person when a name is ambiguous, with candidates", async () => {
    const result = await askQuestion(pool, { question: "What did Alex decide?", as_of: AS_OF }, deps(scriptedPlanner(plan([], { person_mentions: ["Alex"] }))));
    assert.equal(result.outcome, "needs_clarification");
    assert.deepEqual(result.clarification?.candidates.map((candidate) => candidate.id), ["p-alex-chen", "p-alex-rivera"]);
  });

  it("returns partial when one step has no recorded answer", async () => {
    const result = await askQuestion(
      pool,
      { question: "Who owns the Atlas migration and what is its CRM vendor?", as_of: AS_OF },
      deps(scriptedPlanner(plan([step({}), step({ intent: "explain", topic: null, subject: "CRM vendor" })]))),
    );
    assert.equal(result.outcome, "partial");
    assert.match(result.steps[1]?.notes[0] ?? "", /Nothing about "CRM vendor"/);
  });

  // The test build has no vectors, so these searches are full-text only.
  it("finds the topic a subject means by searching the records", async () => {
    const result = await askQuestion(
      pool,
      { question: "What did Atlas decide about chargebacks?", as_of: AS_OF },
      deps(scriptedPlanner(plan([step({ intent: "explain", topic: null, subject: "chargebacks" })]))),
    );
    assert.equal(result.outcome, "answered", JSON.stringify(result.notes));
    assert.deepEqual(result.steps[0]?.request, { intent: "explain", project: "proj-atlas", topic: "payments.fraud_screening", at: "2026-10-18T16:00:00.000Z" });
    assert.match(result.steps[0]?.notes[0] ?? "", /Matched "chargebacks" to Atlas/);
    assert.equal(result.steps[0]?.search?.intent, "search");
  });

  it("asks which topic when a search matches several", async () => {
    const result = await askQuestion(
      pool,
      { question: "What was decided about the migration?", as_of: AS_OF },
      deps(scriptedPlanner(plan([step({ intent: "explain", project_mention: null, topic: null, subject: "migration" })]))),
    );
    assert.equal(result.outcome, "needs_clarification");
    // Only decision topics are offered for a decision question; migration.owner is a role.
    assert.deepEqual(result.clarification?.candidates.map((candidate) => candidate.id).sort(), ["proj-atlas/payments.provider", "proj-cobalt/warehouse.platform"]);
    assert.equal(result.answer, null);
  });

  it("reports insufficient evidence when a search finds nothing", async () => {
    const result = await askQuestion(
      pool,
      { question: "What was decided about the CRM vendor?", as_of: AS_OF },
      deps(scriptedPlanner(plan([step({ intent: "explain", project_mention: null, topic: null, subject: "CRM vendor" })]))),
    );
    assert.equal(result.outcome, "insufficient_evidence");
    assert.match(result.steps[0]?.notes[0] ?? "", /found nothing related/);
  });

  it("runs at most three graph tool calls, searches included", async () => {
    const result = await askQuestion(
      pool,
      { question: "Who owns the Atlas migration and Beacon releases, and what did Atlas decide about chargebacks?", as_of: AS_OF },
      deps(
        scriptedPlanner(
          plan([step({}), step({ project_mention: "proj-beacon", topic: "release.owner" }), step({ intent: "explain", topic: null, subject: "chargebacks" })]),
        ),
      ),
    );
    assert.equal(result.truncated, true);
    assert.equal(result.outcome, "partial");
    assert.ok(result.steps[2]?.search, "the search was the third call");
    assert.equal(result.steps[2]?.request, null);
    assert.match(result.steps[2]?.notes[0] ?? "", /at most 3 graph tool calls/);
  });

  it("returns unavailable when the graph cannot be reached", async () => {
    const result = await askQuestion(pool, { question: "Who owns the Atlas migration?", as_of: AS_OF }, {
      ...deps(scriptedPlanner(plan([step({})]))),
      connect: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    assert.equal(result.outcome, "unavailable");
    assert.deepEqual(result.steps, []);
  });

  it("rejects over-long questions before planning", async () => {
    const planner = scriptedPlanner(plan([step({})]));
    await assert.rejects(askQuestion(pool, { question: "x".repeat(501), as_of: AS_OF }, deps(planner)));
    assert.equal(planner.calls, 0);
  });
});

describe("outcome combination", () => {
  it("orders outcomes by severity", () => {
    assert.equal(combineOutcomes(["answered", "unavailable"], false), "unavailable");
    assert.equal(combineOutcomes(["answered", "conflicting_evidence"], false), "conflicting_evidence");
    assert.equal(combineOutcomes(["insufficient_evidence", "insufficient_evidence"], false), "insufficient_evidence");
    assert.equal(combineOutcomes(["answered", "insufficient_evidence"], false), "partial");
    assert.equal(combineOutcomes(["answered"], true), "partial");
    assert.equal(combineOutcomes(["answered", "answered"], false), "answered");
  });
});
