import type { FalkorDB, Graph } from "falkordb";
import { ensureIndex, graphName, type IndexSpec } from "@/graph/client";
import type { CheckResult } from "@/smoke/check-result";

// Infrastructure smoke fixtures, not business data. The 4-dimensional vectors are hand-picked
// so nearest-neighbour results are deterministic; they are NOT semantic embeddings.
const SMOKE_DIMENSION = 4;
const SMOKE_DOCUMENT = { id: "smoke-doc-1", title: "Smoke fixture: provider change memo" };
const SMOKE_CHUNKS = [
  { id: "smoke-chunk-1", body: "The team approved switching the payments provider to Stripe.", embedding: [1, 0, 0, 0] },
  { id: "smoke-chunk-2", body: "Dana owns the database migration after the handoff.", embedding: [0, 1, 0, 0] },
  { id: "smoke-chunk-3", body: "Open question: whether to keep the legacy webhook relay.", embedding: [0, 0, 1, 0] },
];
const SMOKE_DECISION = { id: "smoke-decision-1", topic: "payments.provider", title: "Use Stripe for payments" };

export const SMOKE_GRAPH_SUFFIX = "smoke";

const SMOKE_INDEXES: IndexSpec[] = [
  { kind: "range", label: "Document", property: "id" },
  { kind: "range", label: "Chunk", property: "id" },
  { kind: "range", label: "Decision", property: "id" },
  { kind: "fulltext", label: "Chunk", property: "body" },
  { kind: "vector", label: "Chunk", property: "embedding", dimension: SMOKE_DIMENSION, similarity: "cosine" },
];

export async function runGraphSmoke(db: FalkorDB): Promise<CheckResult[]> {
  const name = graphName(SMOKE_GRAPH_SUFFIX);
  const otherGraphsBefore = (await db.list()).filter((graph) => graph !== name).sort();
  const graph = db.selectGraph(name);
  const results: CheckResult[] = [];

  // Sequential on purpose: ensureIndex is check-then-create, which concurrent calls would race.
  const indexOutcomes: string[] = [];
  for (const spec of SMOKE_INDEXES) indexOutcomes.push(await ensureIndex(graph, spec));
  results.push({ name: "graph: indexes ensured", ok: true, detail: indexOutcomes.join(", ") });

  await writeFixtures(graph);
  results.push(await checkFixtureCounts(graph));
  results.push(await checkEvidencePath(graph));
  results.push(await checkFulltext(graph));
  results.push(await checkVector(graph));

  const otherGraphsAfter = (await db.list()).filter((graph) => graph !== name).sort();
  results.push({
    name: "graph: other graphs untouched",
    ok: JSON.stringify(otherGraphsBefore) === JSON.stringify(otherGraphsAfter),
    detail: `${otherGraphsAfter.length} other graph(s) present before and after`,
  });
  return results;
}

// MERGE on stable IDs is right for this long-lived smoke graph only. Real builds project into a
// fresh graph per build so corrected facts cannot leave stale edges behind.
async function writeFixtures(graph: Graph): Promise<void> {
  await graph.query("MERGE (d:Document {id: $id}) SET d.title = $title, d.smoke_fixture = true", {
    params: SMOKE_DOCUMENT,
  });
  for (const chunk of SMOKE_CHUNKS) {
    await graph.query(
      `MATCH (doc:Document {id: $documentId})
       MERGE (c:Chunk {id: $id})
       SET c.body = $body, c.embedding = vecf32($embedding), c.smoke_fixture = true
       MERGE (c)-[:PART_OF]->(doc)`,
      { params: { ...chunk, documentId: SMOKE_DOCUMENT.id } },
    );
  }
  await graph.query(
    `MATCH (c:Chunk {id: $chunkId})
     MERGE (d:Claim:Decision {id: $id})
     SET d.topic = $topic, d.title = $title, d.smoke_fixture = true
     MERGE (d)-[:EVIDENCED_BY {role: 'decision'}]->(c)`,
    { params: { ...SMOKE_DECISION, chunkId: "smoke-chunk-1" } },
  );
}

async function checkFixtureCounts(graph: Graph): Promise<CheckResult> {
  const reply = await graph.roQuery<{ documents: number; chunks: number; decisions: number; edges: number }>(
    `MATCH (doc:Document {id: $documentId})
     OPTIONAL MATCH (c:Chunk) WHERE c.id IN $chunkIds
     WITH count(DISTINCT doc) AS documents, count(DISTINCT c) AS chunks
     OPTIONAL MATCH (d:Decision {id: $decisionId})
     WITH documents, chunks, count(d) AS decisions
     OPTIONAL MATCH (:Decision {id: $decisionId})-[e:EVIDENCED_BY]->(:Chunk)
     RETURN documents, chunks, decisions, count(e) AS edges`,
    {
      params: {
        documentId: SMOKE_DOCUMENT.id,
        chunkIds: SMOKE_CHUNKS.map((chunk) => chunk.id),
        decisionId: SMOKE_DECISION.id,
      },
    },
  );
  const row = reply.data?.[0];
  const expected = { documents: 1, chunks: SMOKE_CHUNKS.length, decisions: 1, edges: 1 };
  return {
    name: "graph: parameterised write/read, no duplicates",
    ok: JSON.stringify(row) === JSON.stringify(expected),
    detail: JSON.stringify(row),
  };
}

async function checkEvidencePath(graph: Graph): Promise<CheckResult> {
  const reply = await graph.roQuery<{ decision: string; chunk: string; document: string; role: string }>(
    `MATCH (d:Decision {id: $id})-[e:EVIDENCED_BY]->(c:Chunk)-[:PART_OF]->(doc:Document)
     RETURN d.id AS decision, c.id AS chunk, doc.id AS document, e.role AS role`,
    { params: { id: SMOKE_DECISION.id } },
  );
  const rows = reply.data ?? [];
  const row = rows[0];
  return {
    name: "graph: Decision -EVIDENCED_BY-> Chunk -PART_OF-> Document",
    ok:
      rows.length === 1 &&
      row?.chunk === "smoke-chunk-1" &&
      row.document === SMOKE_DOCUMENT.id &&
      row.role === "decision",
    detail: JSON.stringify(rows),
  };
}

async function checkFulltext(graph: Graph): Promise<CheckResult> {
  const reply = await graph.roQuery<{ id: string; score: number }>(
    "CALL db.idx.fulltext.queryNodes('Chunk', $query) YIELD node, score RETURN node.id AS id, score ORDER BY score DESC",
    { params: { query: "migration" } },
  );
  const rows = reply.data ?? [];
  return {
    name: "graph: full-text index query",
    ok: rows.length === 1 && rows[0]?.id === "smoke-chunk-2",
    detail: JSON.stringify(rows),
  };
}

async function checkVector(graph: Graph): Promise<CheckResult> {
  // With cosine similarity, FalkorDB reports a distance score: lower means closer.
  const reply = await graph.roQuery<{ id: string; score: number }>(
    `CALL db.idx.vector.queryNodes('Chunk', 'embedding', $k, vecf32($vector)) YIELD node, score
     RETURN node.id AS id, score ORDER BY score ASC`,
    { params: { k: 2, vector: [0.1, 0.05, 0.9, 0] } },
  );
  const rows = reply.data ?? [];
  const [first, second] = rows;
  return {
    name: `graph: vector index query (dim ${SMOKE_DIMENSION}, cosine)`,
    ok: rows.length === 2 && first?.id === "smoke-chunk-3" && second !== undefined && Number(first.score) < Number(second.score),
    detail: JSON.stringify(rows.map((row) => ({ id: row.id, score: Number(Number(row.score).toFixed(4)) }))),
  };
}
