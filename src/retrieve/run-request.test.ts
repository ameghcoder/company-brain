import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { FalkorDB } from "falkordb";
import type pg from "pg";
import type { ToolResponse } from "@/contracts/graph-tools";
import { closePool } from "@/db/pool";
import { compareCase } from "@/eval/compare";
import { readExpectedCases, runEval } from "@/eval/run-eval";
import { publishGraph } from "@/graph/activate";
import { connectFalkorDB } from "@/graph/client";
import { DEFAULT_FIXTURE_ROOT, loadFixtures } from "@/ingest/load";
import { loadManifest } from "@/ingest/manifest";
import { readTopicRegistry } from "@/ingest/registry";
import { RequestValidationError, runRequest } from "@/retrieve/run-request";
import { deleteTestGraphs, useFreshTestDatabase, useTestGraphs } from "@/test-support/test-db";

describe("fixed graph tools (real Postgres + FalkorDB)", () => {
  let pool: pg.Pool;
  let db: FalkorDB;

  before(async () => {
    pool = await useFreshTestDatabase();
    db = await connectFalkorDB();
    await useTestGraphs(db);
    await loadFixtures(pool);
    const published = await publishGraph(pool, db, await readTopicRegistry(await loadManifest(DEFAULT_FIXTURE_ROOT)));
    assert.equal(published.activated, true);
  });
  after(async () => {
    await deleteTestGraphs(db);
    await db.close();
    await closePool();
  });

  it("matches every independent expected answer", async () => {
    const report = await runEval(pool, await readExpectedCases(DEFAULT_FIXTURE_ROOT));
    const failures = report.results.filter((result) => !result.ok).map((result) => `${result.id}: ${result.failures.join("; ")}`);
    assert.deepEqual(failures, []);
    assert.equal(report.passed, 21);
    assert.equal(report.build_ids.length, 1, "every request pinned the same build");
  });

  it("fails cases whose expectations are wrong, so the comparison is not vacuous", async () => {
    const cases = await readExpectedCases(DEFAULT_FIXTURE_ROOT);
    const byId = new Map(cases.map((item) => [item.id, item]));
    const mutate = async (id: string, expect: Record<string, unknown>) => {
      const original = byId.get(id);
      assert.ok(original);
      return compareCase({ ...original, expect: { ...original.expect, ...expect } }, await runRequest(pool, original.request));
    };
    assert.equal((await mutate("q3a-migration-owner-today", { assignees: ["p-priya-raman"] })).ok, false);
    assert.equal((await mutate("q2-why-provider-replaced", { decided_by: null })).ok, false);
    assert.equal((await mutate("cobalt-warehouse-no-rationale", { rationale_known: true })).ok, false);
    assert.equal((await mutate("q1-atlas-provider-changes-this-month", { must_not_mention_choices: ["Stripe"] })).ok, false);
    const reordered = byId.get("q4-atlas-timeline")?.expect.events_in_order as unknown[];
    assert.equal((await mutate("q4-atlas-timeline", { events_in_order: [...reordered].reverse() })).ok, false);
    const unknownKey = await mutate("q3a-migration-owner-today", { owner_mood: "happy" });
    assert.deepEqual(unknownKey.failures, ['unhandled expectation key "owner_mood" for intent owner']);
  });

  it("cites only source text that hydrates to the exact quoted spans", async () => {
    const response = await runRequest(pool, { intent: "explain", project: "proj-atlas", topic: "payments.provider", at: "2026-10-18T12:00:00-04:00" });
    const quotes = await pool.query<{ quote: string }>("SELECT item->>'quote' AS quote FROM claims, jsonb_array_elements(evidence) item");
    const known = new Set(quotes.rows.map((row) => row.quote));
    const excerpts = response.sources.flatMap((source) => source.excerpts.map((excerpt) => excerpt.text));
    assert.ok(excerpts.length > 0);
    for (const text of excerpts) assert.ok(known.has(text), `excerpt is not a reviewed quote: ${text}`);
    for (const path of response.paths) {
      assert.match(path.from, /^[a-z]/, "paths use stable application IDs");
      assert.match(path.to, /^[a-z]/);
    }
  });

  it("rejects malformed requests before touching the graph", async () => {
    const connect = async (): Promise<FalkorDB> => {
      throw new Error("the graph must not be contacted for an invalid request");
    };
    const invalid = [
      { intent: "cypher", query: "MATCH (n) DETACH DELETE n" },
      { intent: "owner", project: "proj-atlas", role: "migration.owner", at: "2026-10-18T12:00:00" },
      { intent: "changes", project: "proj-atlas", from: "2026-11-01T00:00:00-04:00", to: "2026-10-01T00:00:00-04:00" },
      { intent: "explain", project: "atlas", topic: "payments.provider", at: "2026-10-18T12:00:00-04:00" },
      { intent: "explain", project: "proj-atlas", topic: "payments.provider' OR 1=1 //", at: "2026-10-18T12:00:00-04:00" },
    ];
    for (const request of invalid) {
      await assert.rejects(runRequest(pool, request, { connect }), RequestValidationError, JSON.stringify(request));
    }
  });

  it("returns unavailable, never a Postgres answer, when the graph cannot be reached", async () => {
    const request = { intent: "owner", project: "proj-atlas", role: "migration.owner", at: "2026-10-18T12:00:00-04:00" };
    const unreachable = async (): Promise<FalkorDB> => {
      throw new Error("connect ECONNREFUSED");
    };
    const response = await runRequest(pool, request, { connect: unreachable });
    assert.deepEqual(
      { outcome: response.outcome, facts: response.facts, sources: response.sources, paths: response.paths },
      { outcome: "unavailable", facts: null, sources: [], paths: [] },
    );
    assert.ok(response.build_id, "the pinned build is still reported");
  });

  it("returns unavailable when no build is active", async () => {
    const active = await pool.query<{ active_build_id: string }>("SELECT active_build_id FROM app_state");
    await pool.query("UPDATE app_state SET active_build_id = NULL");
    try {
      const response: ToolResponse = await runRequest(pool, { intent: "timeline", project: "proj-atlas" });
      assert.equal(response.outcome, "unavailable");
      assert.equal(response.facts, null);
    } finally {
      await pool.query("UPDATE app_state SET active_build_id = $1", [active.rows[0]?.active_build_id]);
    }
  });
});
