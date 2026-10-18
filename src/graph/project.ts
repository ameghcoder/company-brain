import type { Graph } from "falkordb";
import type { Claim } from "@/contracts/claims";
import type { Snapshot } from "@/graph/build.db";
import { ensureIndex } from "@/graph/client";
import type { OwnershipInterval } from "@/graph/ownership-intervals";
import type { TimePoint } from "@/time/company-time";

type Props = Record<string, string | number | boolean | string[] | null>;
type NodeRow = Props & { id: string };
type EdgeRow = { from: string; to: string; props: Props };

const BATCH = 200;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;
const NODE_LABELS = ["Person", "Team", "Project", "Document", "Chunk", "Claim", "Decision", "Ownership", "Supersession"];

// Comparable epoch milliseconds plus what the source actually said, so displays never invent
// precision. Null time points produce no properties at all.
function timeProps(prefix: string, point: TimePoint | null): Props {
  if (!point) return {};
  return {
    [`${prefix}_ms`]: Date.parse(point.utc),
    [`${prefix}_value`]: point.value,
    [`${prefix}_precision`]: point.precision,
  };
}

function compact(props: Props): Props {
  return Object.fromEntries(Object.entries(props).filter(([, value]) => value !== null && value !== undefined));
}

async function createNodes(graph: Graph, labels: string[], rows: NodeRow[]): Promise<void> {
  if (!labels.every((label) => IDENTIFIER.test(label))) throw new Error(`Invalid label in ${labels.join(":")}`);
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH).map(compact);
    const reply = await graph.query<{ created: number }>(
      `UNWIND $rows AS row CREATE (n:${labels.join(":")}) SET n = row RETURN count(n) AS created`,
      { params: { rows: batch } },
    );
    if (reply.data?.[0]?.created !== batch.length) throw new Error(`Created ${reply.data?.[0]?.created} of ${batch.length} ${labels.join(":")} nodes`);
  }
}

// Every edge must find both endpoints; a short count means a dangling reference and fails the build.
async function createEdges(graph: Graph, fromLabel: string, rel: string, toLabel: string, rows: EdgeRow[]): Promise<void> {
  if (![fromLabel, rel, toLabel].every((name) => IDENTIFIER.test(name))) throw new Error("Invalid edge label");
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH).map((row) => ({ ...row, props: compact(row.props) }));
    const reply = await graph.query<{ created: number }>(
      `UNWIND $rows AS row
       MATCH (a:${fromLabel} {id: row.from})
       MATCH (b:${toLabel} {id: row.to})
       CREATE (a)-[r:${rel}]->(b) SET r = row.props
       RETURN count(r) AS created`,
      { params: { rows: batch } },
    );
    if (reply.data?.[0]?.created !== batch.length) {
      throw new Error(`Created ${reply.data?.[0]?.created} of ${batch.length} ${fromLabel}-${rel}->${toLabel} edges`);
    }
  }
}

export async function createIndexes(graph: Graph): Promise<void> {
  for (const label of NODE_LABELS) await ensureIndex(graph, { kind: "range", label, property: "id" });
  await ensureIndex(graph, { kind: "fulltext", label: "Chunk", property: "body" });
}

export async function projectSnapshot(
  graph: Graph,
  snapshot: Snapshot,
  intervals: Map<string, OwnershipInterval>,
  isExclusive: (projectId: string, role: string) => boolean,
): Promise<void> {
  const label = { person: "Person", team: "Team", project: "Project" } as const;
  for (const kind of ["person", "team", "project"] as const) {
    await createNodes(
      graph,
      [label[kind]],
      snapshot.entities.filter((entity) => entity.kind === kind).map((entity) => ({ id: entity.entityId, name: entity.canonicalName, kind })),
    );
  }

  await createNodes(
    graph,
    ["Document"],
    snapshot.versions.map((version) => ({
      id: version.versionId,
      document_id: version.documentId,
      title: version.title,
      source_type: version.sourceType,
      document_type: version.documentType,
      author_id: version.authorId,
      timezone: version.eventAt.timezone,
      ...timeProps("event_at", version.eventAt),
      // Lets search results be scoped to a project.
      project_ids: version.projectIds,
    })),
  );
  await createNodes(
    graph,
    ["Chunk"],
    snapshot.chunks.map((chunk) => ({
      id: chunk.chunkId,
      version_id: chunk.versionId,
      document_id: chunk.documentId,
      chunker_version: chunk.chunkerVersion,
      position: chunk.position,
      heading_path: chunk.headingPath,
      body: chunk.body,
      start_offset: chunk.startOffset,
      end_offset: chunk.endOffset,
    })),
  );
  await createEdges(
    graph,
    "Chunk",
    "PART_OF",
    "Document",
    snapshot.chunks.map((chunk) => ({ from: chunk.chunkId, to: chunk.versionId, props: {} })),
  );

  const byKind = <K extends Claim["kind"]>(kind: K) => snapshot.claims.filter((claim): claim is Extract<Claim, { kind: K }> => claim.kind === kind);
  const decisions = byKind("decision");
  const ownership = byKind("ownership");
  const supersessions = byKind("supersession");
  const common = (claim: Claim): NodeRow => ({
    id: claim.claim_id,
    project_id: claim.project_id,
    topic: claim.topic,
    origin: claim.origin,
    timezone: claim.recorded_at.timezone,
    ...timeProps("recorded_at", claim.recorded_at),
  });

  await createNodes(
    graph,
    ["Claim", "Decision"],
    decisions.map((claim) => ({
      ...common(claim),
      choice: claim.payload.choice,
      title: claim.payload.title,
      lifecycle: claim.payload.lifecycle,
      rationale: claim.payload.rationale,
      decided_by: claim.payload.decided_by,
      effective_basis: claim.payload.effective_basis,
      ...timeProps("proposed_at", claim.payload.proposed_at),
      ...timeProps("decided_at", claim.payload.decided_at),
      ...timeProps("effective_at", claim.payload.effective_at),
    })),
  );

  const startValue = new Map(ownership.map((claim) => [claim.claim_id, claim.payload.effective_from]));
  await createNodes(
    graph,
    ["Claim", "Ownership"],
    ownership.map((claim) => {
      const interval = intervals.get(claim.claim_id);
      if (!interval) throw new Error(`No interval derived for ${claim.claim_id}`);
      // A derived end shows the successor's start as the source wrote it.
      const end = interval.endReason === "handoff" && interval.endedBy ? startValue.get(interval.endedBy) ?? null : claim.payload.effective_to;
      return {
        ...common(claim),
        assignee_id: claim.payload.assignee_id,
        role_exclusive: isExclusive(claim.project_id, claim.topic),
        handoff_from: claim.payload.handoff_from,
        end_reason: interval.endReason,
        ended_by: interval.endedBy,
        ...timeProps("effective_from", claim.payload.effective_from),
        ...(interval.toMs === null ? {} : { ...timeProps("effective_to", end), effective_to_ms: interval.toMs }),
      };
    }),
  );
  await createNodes(
    graph,
    ["Claim", "Supersession"],
    supersessions.map((claim) => ({
      ...common(claim),
      new_decision_id: claim.payload.new_decision_id,
      old_decision_id: claim.payload.old_decision_id,
      ...timeProps("effective_at", claim.payload.effective_at),
    })),
  );

  await createEdges(graph, "Decision", "AFFECTS", "Project", decisions.map((claim) => ({ from: claim.claim_id, to: claim.project_id, props: {} })));
  await createEdges(
    graph,
    "Decision",
    "DECIDED_BY",
    "Person",
    decisions.flatMap((claim) => (claim.payload.decided_by ? [{ from: claim.claim_id, to: claim.payload.decided_by, props: {} }] : [])),
  );
  await createEdges(graph, "Ownership", "FOR_PROJECT", "Project", ownership.map((claim) => ({ from: claim.claim_id, to: claim.project_id, props: {} })));
  const entityKind = new Map(snapshot.entities.map((entity) => [entity.entityId, entity.kind]));
  for (const kind of ["person", "team"] as const) {
    await createEdges(
      graph,
      "Ownership",
      "ASSIGNS_TO",
      label[kind],
      ownership
        .filter((claim) => entityKind.get(claim.payload.assignee_id) === kind)
        .map((claim) => ({ from: claim.claim_id, to: claim.payload.assignee_id, props: {} })),
    );
  }
  await createEdges(
    graph,
    "Supersession",
    "NEW_DECISION",
    "Decision",
    supersessions.map((claim) => ({ from: claim.claim_id, to: claim.payload.new_decision_id, props: {} })),
  );
  await createEdges(
    graph,
    "Supersession",
    "OLD_DECISION",
    "Decision",
    supersessions.map((claim) => ({ from: claim.claim_id, to: claim.payload.old_decision_id, props: {} })),
  );
  await createEdges(
    graph,
    "Decision",
    "SUPERSEDES",
    "Decision",
    supersessions.map((claim) => ({
      from: claim.payload.new_decision_id,
      to: claim.payload.old_decision_id,
      props: { claim_id: claim.claim_id, effective_at_ms: Date.parse(claim.payload.effective_at.utc) },
    })),
  );
  await createEdges(
    graph,
    "Claim",
    "EVIDENCED_BY",
    "Chunk",
    snapshot.claims.flatMap((claim) =>
      claim.evidence.map((item) => ({
        from: claim.claim_id,
        to: item.chunk_id,
        props: { role: item.role, quote_start: item.start, quote_end: item.end },
      })),
    ),
  );
}

// Sets Chunk.embedding from cached vectors and indexes it for cosine similarity search.
export async function projectVectors(graph: Graph, vectors: Map<string, number[]>, dimensions: number): Promise<void> {
  const rows = [...vectors].map(([id, v]) => ({ id, v }));
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const reply = await graph.query<{ updated: number }>(
      "UNWIND $rows AS row MATCH (c:Chunk {id: row.id}) SET c.embedding = vecf32(row.v) RETURN count(c) AS updated",
      { params: { rows: batch } },
    );
    if (reply.data?.[0]?.updated !== batch.length) throw new Error(`Set ${reply.data?.[0]?.updated} of ${batch.length} chunk embeddings`);
  }
  await ensureIndex(graph, { kind: "vector", label: "Chunk", property: "embedding", dimension: dimensions, similarity: "cosine" });
}
