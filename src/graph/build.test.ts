import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { FalkorDB } from "falkordb";
import type pg from "pg";
import { closePool } from "@/db/pool";
import { activateGraph, publishGraph } from "@/graph/activate";
import { readActiveBuild, readBuild } from "@/graph/build.db";
import { rebuildGraph } from "@/graph/build";
import { checkGraph } from "@/graph/check";
import { connectFalkorDB } from "@/graph/client";
import { DEFAULT_FIXTURE_ROOT, loadFixtures } from "@/ingest/load";
import { loadManifest } from "@/ingest/manifest";
import { readTopicRegistry, type TopicRegistry } from "@/ingest/registry";
import { deleteTestGraphs, useFreshTestDatabase, useTestGraphs } from "@/test-support/test-db";

async function scalar(db: FalkorDB, graphName: string, query: string): Promise<number> {
  const reply = await db.selectGraph(graphName).roQuery<{ v: number }>(query);
  return reply.data?.[0]?.v ?? Number.NaN;
}

describe("graph build, check, and activation (real Postgres + FalkorDB)", () => {
  let pool: pg.Pool;
  let db: FalkorDB;
  let topics: TopicRegistry;
  const tempDirs: string[] = [];

  before(async () => {
    pool = await useFreshTestDatabase();
    db = await connectFalkorDB();
    await useTestGraphs(db);
    await loadFixtures(pool);
    topics = await readTopicRegistry(await loadManifest(DEFAULT_FIXTURE_ROOT));
  });
  after(async () => {
    await deleteTestGraphs(db);
    await db.close();
    await closePool();
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("publishes each build into its own fresh graph and leaves earlier graphs alone", async () => {
    const first = await publishGraph(pool, db, topics);
    assert.equal(first.activated, true, JSON.stringify(first.report.checks.filter((check) => !check.ok)));
    const firstNodes = await scalar(db, first.build.graphName, "MATCH (n) RETURN count(n) AS v");

    const second = await publishGraph(pool, db, topics);
    assert.equal(second.activated, true);
    assert.notEqual(second.build.graphName, first.build.graphName);
    assert.equal(second.previous, first.build.buildId);
    assert.equal(await scalar(db, first.build.graphName, "MATCH (n) RETURN count(n) AS v"), firstNodes);
    assert.equal((await readActiveBuild(pool))?.buildId, second.build.buildId);
  });

  it("projects approved claims only, keeping proposals labelled as proposals", async () => {
    const active = await readActiveBuild(pool);
    assert.ok(active);
    assert.equal(await scalar(db, active.graphName, "MATCH (c:Claim {id: 'rej-atlas-stripe-2026-09-03'}) RETURN count(c) AS v"), 0);
    assert.equal(
      await scalar(db, active.graphName, "MATCH (d:Decision {id: 'prop-atlas-stripe-2026-09-03', lifecycle: 'proposed'}) RETURN count(d) AS v"),
      1,
    );
  });

  it("drops relationships of a claim rejected after approval from the next build only", async () => {
    const before = await readActiveBuild(pool);
    assert.ok(before);
    const replacement = "MATCH (:Decision {id: 'dec-atlas-stripe'})-[r:SUPERSEDES]->(:Decision {id: 'dec-atlas-braintree'}) RETURN count(r) AS v";
    assert.equal(await scalar(db, before.graphName, replacement), 1);

    await pool.query("UPDATE claims SET review_status = 'rejected', review_note = 'test correction' WHERE claim_id = 'sup-atlas-provider-2026-10-06'");
    try {
      const corrected = await publishGraph(pool, db, topics);
      assert.equal(corrected.activated, true);
      assert.equal(await scalar(db, corrected.build.graphName, replacement), 0);
      assert.equal(await scalar(db, corrected.build.graphName, "MATCH (s:Supersession {id: 'sup-atlas-provider-2026-10-06'}) RETURN count(s) AS v"), 0);
      // The earlier build's graph is an immutable record of what it contained.
      assert.equal(await scalar(db, before.graphName, replacement), 1);
    } finally {
      await loadFixtures(pool, DEFAULT_FIXTURE_ROOT, ["claims"]);
    }
  });

  it("keeps the earlier build active when a new build fails its checks", async () => {
    const active = await readActiveBuild(pool);
    assert.ok(active);
    const broken = await rebuildGraph(pool, db, topics);
    // Simulate a projection defect: an approved claim loses its evidence edge.
    await db.selectGraph(broken.graphName).query("MATCH (:Claim {id: 'dec-atlas-sift'})-[e:EVIDENCED_BY]->() DELETE e");

    const report = await checkGraph(pool, db, broken.buildId);
    assert.equal(report.ok, false);
    assert.ok(report.checks.some((check) => check.name === "every claim has evidence" && !check.ok && check.detail.includes("dec-atlas-sift")));
    assert.equal((await readBuild(pool, broken.buildId))?.state, "failed");
    await assert.rejects(activateGraph(pool, db, broken.buildId), /only a checked build can be activated/);
    assert.equal((await readActiveBuild(pool))?.buildId, active.buildId);
  });

  it("refuses to activate a build that has not been checked", async () => {
    const unchecked = await rebuildGraph(pool, db, topics);
    await assert.rejects(activateGraph(pool, db, unchecked.buildId), /is built; only a checked build can be activated/);
  });

  it("rebuilds without any network access", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error("network disabled for this test"));
    try {
      const result = await publishGraph(pool, db, topics);
      assert.equal(result.activated, true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("refuses to build when claims cite chunks outside the selected versions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "company-brain-fixtures-"));
    tempDirs.push(root);
    await cp(DEFAULT_FIXTURE_ROOT, root, { recursive: true });
    const file = path.join(root, "documents/cobalt-roadmap-q4.md");
    await writeFile(file, (await readFile(file, "utf8")).replace("Pipeline owner: Jordan Kim.", "Pipeline owner: Jordan Kim (interim)."));
    // Ingest only: the selected version moves but claims still cite the old one.
    await loadFixtures(pool, root, ["ingest"]);
    try {
      await assert.rejects(rebuildGraph(pool, db, topics), /Snapshot is inconsistent; re-run pnpm seed:claims/);
    } finally {
      await loadFixtures(pool);
    }
  });
});
