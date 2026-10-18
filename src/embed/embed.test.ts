import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { FalkorDB } from "falkordb";
import type pg from "pg";
import { closePool } from "@/db/pool";
import { embedChunks, InvalidEmbeddingError, type Embedder } from "@/embed/embed";
import { publishGraph } from "@/graph/activate";
import { readBuild } from "@/graph/build.db";
import { rebuildGraph } from "@/graph/build";
import { connectFalkorDB } from "@/graph/client";
import { DEFAULT_FIXTURE_ROOT, loadFixtures } from "@/ingest/load";
import { loadManifest } from "@/ingest/manifest";
import { readTopicRegistry, type TopicRegistry } from "@/ingest/registry";
import { deleteTestGraphs, useFreshTestDatabase, useTestGraphs } from "@/test-support/test-db";

// TEST VECTORS, not semantic embeddings: each input maps to a fixed pseudo-random vector derived
// from its hash, so the cache, projection, and vector index can be exercised without a provider.
const TEST_MODEL = "test-fixture-vectors";

function testVector(input: string, dimensions: number): number[] {
  const bytes = createHash("sha256").update(input).digest();
  return Array.from({ length: dimensions }, (_, i) => ((bytes[i % bytes.length] ?? 0) - 127.5) / 127.5);
}

function scriptedEmbedder(dimensions: number, mutate?: (vector: number[]) => unknown[]): Embedder & { calls: number } {
  const embedder = {
    model: TEST_MODEL,
    dimensions,
    calls: 0,
    async embed(inputs: string[]) {
      embedder.calls++;
      return inputs.map((input) => (mutate ? mutate(testVector(input, dimensions)) : testVector(input, dimensions))) as number[][];
    },
  };
  return embedder;
}

describe("embedding cache and vector projection (real Postgres + FalkorDB, test vectors)", () => {
  let pool: pg.Pool;
  let db: FalkorDB;
  let topics: TopicRegistry;
  const saved = { model: process.env.OPENAI_EMBEDDING_MODEL, dimensions: process.env.OPENAI_EMBEDDING_DIMENSIONS };
  const settings8 = { model: TEST_MODEL, dimensions: 8 };
  const cached = async (dimensions: number) =>
    Number((await pool.query("SELECT count(*) FROM embedding_cache WHERE model = $1 AND dimensions = $2", [TEST_MODEL, dimensions])).rows[0].count);

  before(async () => {
    pool = await useFreshTestDatabase();
    db = await connectFalkorDB();
    await useTestGraphs(db);
    await loadFixtures(pool);
    topics = await readTopicRegistry(await loadManifest(DEFAULT_FIXTURE_ROOT));
  });
  after(async () => {
    process.env.OPENAI_EMBEDDING_MODEL = saved.model ?? "";
    process.env.OPENAI_EMBEDDING_DIMENSIONS = saved.dimensions ?? "";
    await deleteTestGraphs(db);
    await db.close();
    await closePool();
  });

  it("embeds only missing inputs and caches per model and dimensions", async () => {
    const first = scriptedEmbedder(8);
    const result = await embedChunks(pool, first, settings8);
    const chunks = Number((await pool.query("SELECT count(DISTINCT embedding_input_hash) FROM chunks")).rows[0].count);
    assert.deepEqual(result, { missing: chunks, embedded: chunks, batches: 1 });

    const second = scriptedEmbedder(8);
    assert.deepEqual(await embedChunks(pool, second, settings8), { missing: 0, embedded: 0, batches: 0 });
    assert.equal(second.calls, 0);

    const otherDimensions = await embedChunks(pool, scriptedEmbedder(4), { model: TEST_MODEL, dimensions: 4 });
    assert.equal(otherDimensions.embedded, chunks, "a different dimension count never reuses 8-dim vectors");
    assert.equal(await cached(8), chunks);
  });

  it("rejects wrong-length or non-finite vectors and stores nothing from the batch", async () => {
    const settings6 = { model: TEST_MODEL, dimensions: 6 };
    await assert.rejects(embedChunks(pool, scriptedEmbedder(6, (v) => v.slice(1)), settings6), InvalidEmbeddingError);
    await assert.rejects(embedChunks(pool, scriptedEmbedder(6, (v) => [Number.NaN, ...v.slice(1)]), settings6), /non-finite/);
    assert.equal(await cached(6), 0);
  });

  it("creates a new cache entry when a chunk's embedding input changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "company-brain-embed-"));
    try {
      await cp(DEFAULT_FIXTURE_ROOT, root, { recursive: true });
      const file = path.join(root, "documents/atlas-fraud-screening.md");
      await writeFile(file, (await readFile(file, "utf8")).replace("not the payments provider.", "not the payment provider."));
      await loadFixtures(pool, root);
      const result = await embedChunks(pool, scriptedEmbedder(8), settings8);
      assert.equal(result.embedded, 1, "only the changed chunk needs a new vector");
    } finally {
      await loadFixtures(pool);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("projects cached vectors with a vector index and passes the vector checks", async () => {
    process.env.OPENAI_EMBEDDING_MODEL = TEST_MODEL;
    process.env.OPENAI_EMBEDDING_DIMENSIONS = "8";
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error("network disabled for this test"));
    try {
      const published = await publishGraph(pool, db, topics);
      assert.equal(published.activated, true, JSON.stringify(published.report.checks.filter((check) => !check.ok)));
      const names = published.report.checks.map((check) => check.name);
      assert.ok(names.includes("every chunk has an embedding") && names.includes("vector index returns a chunk as its own nearest neighbour"));
      assert.deepEqual((await readBuild(pool, published.build.buildId))?.config.vectors, { model: TEST_MODEL, dimensions: 8, similarity: "cosine" });
      const embedded = await db.selectGraph(published.build.graphName).roQuery<{ v: number }>("MATCH (c:Chunk) WHERE c.embedding IS NOT NULL RETURN count(c) AS v");
      const chunks = await db.selectGraph(published.build.graphName).roQuery<{ v: number }>("MATCH (c:Chunk) RETURN count(c) AS v");
      assert.equal(embedded.data?.[0]?.v, chunks.data?.[0]?.v);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("refuses to build before creating a graph when any vector is missing", async () => {
    process.env.OPENAI_EMBEDDING_MODEL = TEST_MODEL;
    process.env.OPENAI_EMBEDDING_DIMENSIONS = "8";
    await pool.query(
      `DELETE FROM embedding_cache WHERE model = $1 AND dimensions = 8 AND input_hash = (
         SELECT c.embedding_input_hash FROM documents d JOIN chunks c ON c.version_id = d.selected_version_id ORDER BY c.chunk_id LIMIT 1)`,
      [TEST_MODEL],
    );
    const graphsBefore = (await db.list()).length;
    await assert.rejects(rebuildGraph(pool, db, topics), /1 selected chunk\(s\) have no cached test-fixture-vectors\/8 embedding/);
    assert.equal((await db.list()).length, graphsBefore);
    await embedChunks(pool, scriptedEmbedder(8), settings8);
  });

  it("projects no vectors when embeddings are not configured", async () => {
    process.env.OPENAI_EMBEDDING_MODEL = "";
    process.env.OPENAI_EMBEDDING_DIMENSIONS = "";
    const build = await rebuildGraph(pool, db, topics);
    assert.equal((await readBuild(pool, build.buildId))?.config.vectors, "absent");
  });
});
