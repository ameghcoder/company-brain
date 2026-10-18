import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { closePool } from "@/db/pool";
import { ClaimValidationError } from "@/extract/seed-claims";
import { DEFAULT_FIXTURE_ROOT, loadFixtures } from "@/ingest/load";
import { resolveAlias } from "@/ingest/registry.db";
import { useFreshTestDatabase } from "@/test-support/test-db";

async function counts(pool: pg.Pool) {
  const tables = ["sources", "documents", "document_versions", "chunks", "entities", "entity_aliases", "claims"];
  const entries = await Promise.all(
    tables.map(async (table) => [table, Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count)] as const),
  );
  return Object.fromEntries(entries);
}

async function copyFixtures(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "company-brain-fixtures-"));
  await cp(DEFAULT_FIXTURE_ROOT, dir, { recursive: true });
  return dir;
}

describe("fixture loading (real Postgres)", () => {
  let pool: pg.Pool;
  const tempDirs: string[] = [];

  before(async () => {
    pool = await useFreshTestDatabase();
  });
  after(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    await closePool();
  });

  it("loads the dataset and creates nothing new on a second load", async () => {
    const first = await loadFixtures(pool);
    assert.equal(first.ingest?.versionsCreated, 14);
    assert.equal(first.claims?.inserted, 17);
    const afterFirst = await counts(pool);

    const second = await loadFixtures(pool);
    assert.deepEqual(second.ingest, { documents: 14, versionsCreated: 0, chunksCreated: 0, selectionsChanged: 0 });
    assert.deepEqual(second.claims, { inserted: 0, updated: 0, unchanged: 17, retired: 0 });
    assert.deepEqual(await counts(pool), afterFirst);
  });

  it("keeps the old version and selects a new one when a document changes", async () => {
    const root = await copyFixtures();
    tempDirs.push(root);
    const file = path.join(root, "documents/atlas-fraud-screening.md");
    await writeFile(file, `${await readFile(file, "utf8")}\n## Follow-up\n\nReview Sift rules monthly.\n`);

    const before = await pool.query("SELECT selected_version_id FROM documents WHERE document_id = 'atlas-fraud-screening'");
    const result = await loadFixtures(pool, root);
    assert.equal(result.ingest?.versionsCreated, 1);
    assert.equal(result.ingest?.selectionsChanged, 1);

    const versions = await pool.query(
      "SELECT version_id FROM document_versions WHERE document_id = 'atlas-fraud-screening' ORDER BY created_at",
    );
    assert.equal(versions.rowCount, 2);
    const selected = await pool.query("SELECT selected_version_id FROM documents WHERE document_id = 'atlas-fraud-screening'");
    assert.notEqual(selected.rows[0].selected_version_id, before.rows[0].selected_version_id);
    // Claims citing the document re-resolve against the new selected version.
    const claim = await pool.query("SELECT evidence FROM claims WHERE claim_id = 'dec-atlas-sift'");
    assert.ok(claim.rows[0].evidence.every((item: { version_id: string }) => item.version_id === selected.rows[0].selected_version_id));

    await loadFixtures(pool); // restore the original selection for the following tests
  });

  it("keeps an alias shared by two people ambiguous", async () => {
    assert.deepEqual(await resolveAlias(pool, "Alex", "person"), {
      status: "ambiguous",
      candidates: ["p-alex-chen", "p-alex-rivera"],
    });
    assert.deepEqual(await resolveAlias(pool, "  MARCUS ", "person"), { status: "resolved", entityId: "p-marcus-lee" });
    assert.deepEqual(await resolveAlias(pool, "Marcus", "team"), { status: "unknown" });
  });

  it("rejects a claim whose quote is not in the source and writes nothing", async () => {
    const root = await copyFixtures();
    tempDirs.push(root);
    const file = path.join(root, "claims/reviewed-claims.json");
    const reviewed = await readFile(file, "utf8");
    await writeFile(file, reviewed.replace("Pipeline owner: Jordan Kim.", "Pipeline owner: Jordan Kim is great."));

    const before = await pool.query("SELECT claim_id, updated_at FROM claims ORDER BY claim_id");
    await assert.rejects(loadFixtures(pool, root), (error: unknown) => {
      assert.ok(error instanceof ClaimValidationError);
      assert.match(error.message, /own-cobalt-pipeline-jordan: evidence \(assignment\): quote not found in cobalt-roadmap-q4/);
      return true;
    });
    const afterFailure = await pool.query("SELECT claim_id, updated_at FROM claims ORDER BY claim_id");
    assert.deepEqual(afterFailure.rows, before.rows);
  });
});
