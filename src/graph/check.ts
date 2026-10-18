import type { FalkorDB, Graph } from "falkordb";
import type pg from "pg";
import { readVectors } from "@/embed/embed.db";
import { finishBuild, readBuild, readChunkBodies, readChunkInputHashes, type BuildRow } from "@/graph/build.db";
import type { CheckResult } from "@/smoke/check-result";

export type CheckReport = { buildId: string; ok: boolean; checks: CheckResult[]; conflicts: unknown };

const COUNTED_LABELS = ["Person", "Team", "Project", "Document", "Chunk", "Decision", "Ownership", "Supersession"];
const COUNTED_EDGES = ["EVIDENCED_BY", "SUPERSEDES"];

// Structural and query checks against the build's recorded selection. Marks the build "checked"
// only if every check passes; otherwise "failed", and it can never be activated.
export async function checkGraph(pool: pg.Pool, db: FalkorDB, buildId: string): Promise<CheckReport> {
  const build = await readBuild(pool, buildId);
  if (!build) throw new Error(`Unknown build ${buildId}`);
  if (build.state !== "built" && build.state !== "checked") throw new Error(`Build ${buildId} is ${build.state}; only built builds can be checked`);
  if (!(await db.list()).includes(build.graphName)) throw new Error(`Graph ${build.graphName} for build ${buildId} does not exist`);

  const graph = db.selectGraph(build.graphName);
  const checks: CheckResult[] = [];
  const run = async (name: string, fn: () => Promise<{ ok: boolean; detail: string }>) => {
    try {
      checks.push({ name, ...(await fn()) });
    } catch (error) {
      checks.push({ name, ok: false, detail: `query failed: ${(error as Error).message}` });
    }
  };

  await run("node and edge counts match the selection", () => countsMatch(graph, build));
  await run("claim IDs match the selection", async () => {
    const ids = (await values<string>(graph, "MATCH (c:Claim) RETURN c.id AS v ORDER BY v")).join(",");
    const expected = [...build.selection.claimIds].sort().join(",");
    return { ok: ids === expected, detail: ids === expected ? `${build.selection.claimIds.length} claims` : "claim sets differ" };
  });
  await run("IDs are unique per label", async () => {
    const duplicated: string[] = [];
    for (const label of COUNTED_LABELS) {
      const [total, distinct] = await values<number>(graph, `MATCH (n:${label}) RETURN count(n) AS v UNION ALL MATCH (n:${label}) RETURN count(DISTINCT n.id) AS v`);
      if (total !== distinct) duplicated.push(label);
    }
    return { ok: duplicated.length === 0, detail: duplicated.length ? `duplicates in ${duplicated.join(", ")}` : "unique" };
  });
  await run("every claim has evidence", () =>
    none(graph, "MATCH (c:Claim) WHERE NOT (c)-[:EVIDENCED_BY]->(:Chunk) RETURN c.id AS v"),
  );
  await run("evidence spans fall inside their chunks", () =>
    none(graph, "MATCH (c:Claim)-[e:EVIDENCED_BY]->(k:Chunk) WHERE e.quote_start < 0 OR e.quote_end > size(k.body) OR e.quote_start >= e.quote_end RETURN c.id AS v"),
  );
  await run("every chunk is part of exactly its document version", () =>
    none(
      graph,
      `MATCH (k:Chunk) OPTIONAL MATCH (k)-[:PART_OF]->(d:Document)
       WITH k, collect(d.id) AS docs WHERE size(docs) <> 1 OR docs[0] <> k.version_id RETURN k.id AS v`,
    ),
  );
  await run("decisions affect exactly their project", () =>
    none(
      graph,
      `MATCH (d:Decision) OPTIONAL MATCH (d)-[:AFFECTS]->(p:Project)
       WITH d, collect(p.id) AS projects WHERE size(projects) <> 1 OR projects[0] <> d.project_id RETURN d.id AS v`,
    ),
  );
  await run("decided_by edges match the decision", () =>
    none(
      graph,
      `MATCH (d:Decision) OPTIONAL MATCH (d)-[:DECIDED_BY]->(p:Person)
       WITH d, collect(p.id) AS people
       WHERE (d.decided_by IS NULL AND size(people) <> 0) OR (d.decided_by IS NOT NULL AND (size(people) <> 1 OR people[0] <> d.decided_by))
       RETURN d.id AS v`,
    ),
  );
  await run("ownership has exactly its project and assignee", () =>
    none(
      graph,
      `MATCH (o:Ownership)
       OPTIONAL MATCH (o)-[:FOR_PROJECT]->(p:Project)
       WITH o, collect(p.id) AS projects
       OPTIONAL MATCH (o)-[:ASSIGNS_TO]->(a)
       WITH o, projects, collect(a.id) AS assignees
       WHERE size(projects) <> 1 OR projects[0] <> o.project_id OR size(assignees) <> 1 OR assignees[0] <> o.assignee_id
       RETURN o.id AS v`,
    ),
  );
  await run("ownership intervals are ordered", () =>
    none(graph, "MATCH (o:Ownership) WHERE o.effective_to_ms IS NOT NULL AND o.effective_to_ms <= o.effective_from_ms RETURN o.id AS v"),
  );
  await run("supersessions link their two decisions", () =>
    none(
      graph,
      `MATCH (s:Supersession)
       OPTIONAL MATCH (s)-[:NEW_DECISION]->(n:Decision)
       WITH s, collect(n.id) AS news
       OPTIONAL MATCH (s)-[:OLD_DECISION]->(o:Decision)
       WITH s, news, collect(o.id) AS olds
       WHERE size(news) <> 1 OR size(olds) <> 1 OR news[0] <> s.new_decision_id OR olds[0] <> s.old_decision_id
       RETURN s.id AS v`,
    ),
  );
  await run("replacements stay within one project and topic", () =>
    none(
      graph,
      `MATCH (n:Decision)-[r:SUPERSEDES]->(o:Decision)
       WHERE n.project_id <> o.project_id OR n.topic <> o.topic OR n.id = o.id
       RETURN r.claim_id AS v`,
    ),
  );
  await run("no replacement cycles", () => none(graph, "MATCH p = (d:Decision)-[:SUPERSEDES*1..8]->(d) RETURN d.id AS v"));
  await run("proposals never replace or get replaced", () =>
    none(graph, "MATCH (d:Decision {lifecycle: 'proposed'})-[:SUPERSEDES]-() RETURN d.id AS v"),
  );
  await run("chunk text round-trips exactly", async () => {
    const reply = await graph.roQuery<{ id: string; body: string }>("MATCH (k:Chunk) RETURN k.id AS id, k.body AS body");
    const rows = reply.data ?? [];
    const stored = await readChunkBodies(pool, rows.map((row) => row.id));
    const mismatched = rows.filter((row) => stored.get(row.id) !== row.body).map((row) => row.id);
    return { ok: mismatched.length === 0 && rows.length > 0, detail: mismatched.length ? `differs: ${mismatched.join(", ")}` : `${rows.length} chunks identical` };
  });
  await run("full-text index finds a known chunk", async () => {
    const sample = await graph.roQuery<{ id: string; body: string }>("MATCH (k:Chunk) RETURN k.id AS id, k.body AS body ORDER BY k.id LIMIT 1");
    const chunk = sample.data?.[0];
    const word = chunk?.body.match(/[A-Za-z]{6,}/)?.[0];
    if (!chunk || !word) return { ok: false, detail: "no chunk with a searchable word" };
    const hits = await values<string>(graph, "CALL db.idx.fulltext.queryNodes('Chunk', $q) YIELD node RETURN node.id AS v", { q: word });
    return { ok: hits.includes(chunk.id), detail: `"${word}" -> ${hits.length} hit(s)` };
  });

  const vectors = build.config.vectors;
  if (vectors && typeof vectors === "object") {
    const settings = vectors as { model: string; dimensions: number };
    await run("every chunk has an embedding", () => none(graph, "MATCH (k:Chunk) WHERE k.embedding IS NULL RETURN k.id AS v"));
    await run("vector index returns a chunk as its own nearest neighbour", async () => {
      const [chunkId] = await values<string>(graph, "MATCH (k:Chunk) RETURN k.id AS v ORDER BY k.id LIMIT 1");
      if (!chunkId) return { ok: false, detail: "no chunks" };
      const hash = (await readChunkInputHashes(pool, [chunkId])).get(chunkId) ?? "";
      const vector = (await readVectors(pool, settings, [hash])).get(hash);
      if (!vector) return { ok: false, detail: `no cached vector for ${chunkId}` };
      const reply = await graph.roQuery<{ id: string; score: number }>(
        "CALL db.idx.vector.queryNodes('Chunk', 'embedding', 1, vecf32($v)) YIELD node, score RETURN node.id AS id, score",
        { params: { v: vector } },
      );
      const top = reply.data?.[0];
      return { ok: top?.id === chunkId, detail: `nearest ${top?.id ?? "none"} (distance ${Number(top?.score ?? NaN).toFixed(4)})` };
    });
  }

  const ok = checks.every((check) => check.ok);
  const conflicts = (build.integrity as { conflicts?: unknown } | null)?.conflicts ?? [];
  await finishBuild(pool, buildId, ok ? "checked" : "failed", {
    integrity: { checks, conflicts },
    error: ok ? undefined : `${checks.filter((check) => !check.ok).length} check(s) failed`,
  });
  return { buildId, ok, checks, conflicts };
}

async function values<T>(graph: Graph, query: string, params?: Record<string, string | number | number[]>): Promise<T[]> {
  const reply = await graph.roQuery<{ v: T }>(query, params ? { params } : undefined);
  return (reply.data ?? []).map((row) => row.v);
}

async function none(graph: Graph, query: string): Promise<{ ok: boolean; detail: string }> {
  const offenders = await values<string>(graph, query);
  return { ok: offenders.length === 0, detail: offenders.length ? `offending: ${offenders.slice(0, 10).join(", ")}` : "ok" };
}

async function countsMatch(graph: Graph, build: BuildRow): Promise<{ ok: boolean; detail: string }> {
  const mismatches: string[] = [];
  for (const label of COUNTED_LABELS) {
    const [actual] = await values<number>(graph, `MATCH (n:${label}) RETURN count(n) AS v`);
    if (actual !== build.selection.counts[label]) mismatches.push(`${label} ${actual}/${build.selection.counts[label]}`);
  }
  for (const rel of COUNTED_EDGES) {
    const [actual] = await values<number>(graph, `MATCH ()-[r:${rel}]->() RETURN count(r) AS v`);
    if (actual !== build.selection.counts[rel]) mismatches.push(`${rel} ${actual}/${build.selection.counts[rel]}`);
  }
  return { ok: mismatches.length === 0, detail: mismatches.length ? mismatches.join("; ") : JSON.stringify(build.selection.counts) };
}
