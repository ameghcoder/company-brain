import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { FalkorDB } from "falkordb";
import type pg from "pg";
import { closePool } from "@/db/pool";
import { activateGraph, publishGraph } from "@/graph/activate";
import { readActiveBuild } from "@/graph/build.db";
import { rebuildGraph } from "@/graph/build";
import { connectFalkorDB, graphName } from "@/graph/client";
import { pruneGraphs } from "@/graph/prune";
import { DEFAULT_FIXTURE_ROOT, loadFixtures } from "@/ingest/load";
import { loadManifest } from "@/ingest/manifest";
import { readTopicRegistry } from "@/ingest/registry";
import { deleteTestGraphs, useFreshTestDatabase, useTestGraphs } from "@/test-support/test-db";

describe("graph retention (real Postgres + FalkorDB)", () => {
  let pool: pg.Pool;
  let db: FalkorDB;
  const builds: Record<"a" | "b" | "c" | "unactivated", { buildId: string; graphName: string }> = {} as never;
  const stray = () => graphName("stray_not_a_build");

  before(async () => {
    pool = await useFreshTestDatabase();
    db = await connectFalkorDB();
    await useTestGraphs(db);
    await loadFixtures(pool);
    const topics = await readTopicRegistry(await loadManifest(DEFAULT_FIXTURE_ROOT));
    for (const key of ["a", "b", "c"] as const) {
      const published = await publishGraph(pool, db, topics);
      assert.equal(published.activated, true);
      builds[key] = published.build;
    }
    builds.unactivated = await rebuildGraph(pool, db, topics);
    await db.selectGraph(stray()).query("CREATE (:Stray {id: 1})");
  });
  after(async () => {
    await deleteTestGraphs(db);
    await db.close();
    await closePool();
  });

  const graphs = async () => new Set(await db.list());

  it("records when a build stops being active", async () => {
    const rows = await pool.query<{ build_id: string; retired: boolean }>("SELECT build_id, retired_at IS NOT NULL AS retired FROM graph_builds");
    const retired = new Map(rows.rows.map((row) => [row.build_id, row.retired]));
    assert.equal(retired.get(builds.a.buildId), true);
    assert.equal(retired.get(builds.b.buildId), true);
    assert.equal(retired.get(builds.c.buildId), false, "the active build is not retired");
  });

  it("prunes nothing inside the grace period, and nothing on a dry run", async () => {
    const graced = await pruneGraphs(pool, db);
    assert.deepEqual(graced.pruned, []);
    const dry = await pruneGraphs(pool, db, { graceMinutes: 0, dryRun: true });
    assert.deepEqual(dry.pruned.map((build) => build.buildId).sort(), [builds.a.buildId, builds.unactivated.buildId].sort());
    const present = await graphs();
    for (const build of Object.values(builds)) assert.ok(present.has(build.graphName), "a dry run deletes nothing");
  });

  it("keeps the active build, one rollback build, and graphs no build row names", async () => {
    const report = await pruneGraphs(pool, db, { graceMinutes: 0 });
    assert.equal(report.active, builds.c.buildId);
    assert.deepEqual(report.kept, [{ buildId: builds.b.buildId, reason: "rollback" }]);
    const present = await graphs();
    assert.ok(present.has(builds.c.graphName) && present.has(builds.b.graphName));
    assert.ok(!present.has(builds.a.graphName) && !present.has(builds.unactivated.graphName));
    assert.ok(present.has(stray()), "a graph not named by a build row is never deleted");
    assert.equal((await readActiveBuild(pool))?.buildId, builds.c.buildId);
    // Rows stay as provenance.
    const rows = await pool.query("SELECT count(*) FROM graph_builds WHERE pruned_at IS NOT NULL");
    assert.equal(Number(rows.rows[0].count), 2);
    // Pruning again finds nothing new.
    assert.deepEqual((await pruneGraphs(pool, db, { graceMinutes: 0 })).pruned, []);
  });

  it("never reactivates a pruned build, and rolls back to the kept one", async () => {
    await assert.rejects(activateGraph(pool, db, builds.a.buildId), /does not exist|was pruned/);
    await activateGraph(pool, db, builds.b.buildId);
    assert.equal((await readActiveBuild(pool))?.buildId, builds.b.buildId);
    // c is now the retired rollback build; b, active, is never a candidate.
    const report = await pruneGraphs(pool, db, { graceMinutes: 0 });
    assert.deepEqual(report.kept, [{ buildId: builds.c.buildId, reason: "rollback" }]);
    assert.deepEqual(report.pruned, []);
  });
});
