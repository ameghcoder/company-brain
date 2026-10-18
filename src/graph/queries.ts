import type { Graph } from "falkordb";
import type { EvidenceItem, LocalTime } from "@/contracts/graph-tools";

// Fixed, parameterised read queries over a pinned build. Callers pass only validated values as
// parameters; nothing here is assembled from user or model text.

type RawEvidence = { chunk_id: string | null; role: EvidenceItem["role"]; start: number; end: number; version_id: string; document_id: string };

const EVIDENCE = `{chunk_id: k.id, role: e.role, start: e.quote_start, end: e.quote_end, version_id: doc.id, document_id: doc.document_id}`;

function time(ms: number | null, value: string | null, precision: string | null): LocalTime | null {
  return ms === null || value === null ? null : { ms, value, precision: precision ?? "day" };
}

function evidenceOf(claimId: string, raw: RawEvidence[]): EvidenceItem[] {
  // OPTIONAL MATCH yields one all-null map when a claim has no evidence; drop it.
  return raw
    .filter((item): item is RawEvidence & { chunk_id: string } => item.chunk_id !== null)
    .map((item) => ({ claim_id: claimId, chunk_id: item.chunk_id, document_id: item.document_id, version_id: item.version_id, role: item.role, start: item.start, end: item.end }))
    .sort((a, b) => a.chunk_id.localeCompare(b.chunk_id) || a.start - b.start || a.role.localeCompare(b.role));
}

export async function findProject(graph: Graph, projectId: string): Promise<{ id: string; name: string } | undefined> {
  const reply = await graph.roQuery<{ id: string; name: string }>("MATCH (p:Project {id: $project}) RETURN p.id AS id, p.name AS name", {
    params: { project: projectId },
  });
  return reply.data?.[0];
}

export type DecisionRow = {
  claimId: string;
  topic: string;
  choice: string;
  title: string;
  lifecycle: "proposed" | "decided";
  proposedAt: LocalTime | null;
  decidedAt: LocalTime | null;
  effectiveAt: LocalTime | null;
  effectiveBasis: "stated" | "decision_date" | null;
  rationale: string | null;
  decidedBy: { id: string; name: string } | null;
  evidence: EvidenceItem[];
  // Decided, already effective, and not replaced by a replacement effective at or before `at`.
  currentAt: boolean;
};

export async function decisionsFor(graph: Graph, projectId: string, topic: string | null, atMs: number): Promise<DecisionRow[]> {
  const reply = await graph.roQuery<Record<string, unknown>>(
    `MATCH (d:Decision)-[:AFFECTS]->(:Project {id: $project})
     WHERE $topic IS NULL OR d.topic = $topic
     OPTIONAL MATCH (d)-[:DECIDED_BY]->(person:Person)
     WITH d, person
     OPTIONAL MATCH (d)-[e:EVIDENCED_BY]->(k:Chunk)-[:PART_OF]->(doc:Document)
     WITH d, person, collect(${EVIDENCE}) AS evidence
     OPTIONAL MATCH (newer:Decision)-[r:SUPERSEDES]->(d)
     WITH d, person, evidence, collect({by: newer.id, ms: r.effective_at_ms}) AS replaced_by
     RETURN d.id AS claim_id, d.topic AS topic, d.choice AS choice, d.title AS title, d.lifecycle AS lifecycle,
            d.proposed_at_ms AS proposed_ms, d.proposed_at_value AS proposed_value, d.proposed_at_precision AS proposed_precision,
            d.decided_at_ms AS decided_ms, d.decided_at_value AS decided_value, d.decided_at_precision AS decided_precision,
            d.effective_at_ms AS effective_ms, d.effective_at_value AS effective_value, d.effective_at_precision AS effective_precision,
            d.effective_basis AS effective_basis, d.rationale AS rationale,
            person.id AS decided_by_id, person.name AS decided_by_name, evidence,
            (d.lifecycle = 'decided' AND d.effective_at_ms <= $at
              AND size([x IN replaced_by WHERE x.by IS NOT NULL AND x.ms <= $at]) = 0) AS current_at
     ORDER BY claim_id`,
    { params: { project: projectId, topic, at: atMs } },
  );
  return (reply.data ?? []).map((row) => {
    const claimId = row.claim_id as string;
    return {
      claimId,
      topic: row.topic as string,
      choice: row.choice as string,
      title: row.title as string,
      lifecycle: row.lifecycle as DecisionRow["lifecycle"],
      proposedAt: time(row.proposed_ms as number | null, row.proposed_value as string | null, row.proposed_precision as string | null),
      decidedAt: time(row.decided_ms as number | null, row.decided_value as string | null, row.decided_precision as string | null),
      effectiveAt: time(row.effective_ms as number | null, row.effective_value as string | null, row.effective_precision as string | null),
      effectiveBasis: (row.effective_basis as DecisionRow["effectiveBasis"]) ?? null,
      rationale: (row.rationale as string | null) ?? null,
      decidedBy: row.decided_by_id ? { id: row.decided_by_id as string, name: row.decided_by_name as string } : null,
      evidence: evidenceOf(claimId, row.evidence as RawEvidence[]),
      currentAt: row.current_at === true,
    };
  });
}

export type ReplacementRow = {
  claimId: string;
  topic: string;
  effectiveAt: LocalTime;
  newDecisionId: string;
  oldDecisionId: string;
  evidence: EvidenceItem[];
};

// Only supersessions whose derived SUPERSEDES edge exists, so every row is a complete graph path.
export async function replacementsFor(graph: Graph, projectId: string, topic: string | null): Promise<ReplacementRow[]> {
  const reply = await graph.roQuery<Record<string, unknown>>(
    `MATCH (s:Supersession)-[:NEW_DECISION]->(n:Decision)-[:AFFECTS]->(:Project {id: $project})
     MATCH (s)-[:OLD_DECISION]->(o:Decision)
     MATCH (n)-[r:SUPERSEDES]->(o)
     WHERE r.claim_id = s.id AND ($topic IS NULL OR s.topic = $topic)
     OPTIONAL MATCH (s)-[e:EVIDENCED_BY]->(k:Chunk)-[:PART_OF]->(doc:Document)
     WITH s, n, o, collect(${EVIDENCE}) AS evidence
     RETURN s.id AS claim_id, s.topic AS topic, s.effective_at_ms AS effective_ms, s.effective_at_value AS effective_value,
            s.effective_at_precision AS effective_precision, n.id AS new_id, o.id AS old_id, evidence
     ORDER BY effective_ms, claim_id`,
    { params: { project: projectId, topic } },
  );
  return (reply.data ?? []).map((row) => {
    const claimId = row.claim_id as string;
    const effectiveAt = time(row.effective_ms as number, row.effective_value as string, row.effective_precision as string);
    if (!effectiveAt) throw new Error(`Supersession ${claimId} has no effective time`);
    return {
      claimId,
      topic: row.topic as string,
      effectiveAt,
      newDecisionId: row.new_id as string,
      oldDecisionId: row.old_id as string,
      evidence: evidenceOf(claimId, row.evidence as RawEvidence[]),
    };
  });
}

export type AssignmentRow = {
  claimId: string;
  role: string;
  assignee: { id: string; name: string; kind: string };
  exclusive: boolean;
  from: LocalTime;
  to: LocalTime | null;
  endReason: "stated" | "handoff" | null;
  endedBy: string | null;
  handoffFrom: string | null;
  evidence: EvidenceItem[];
  // Half-open: from <= at < to (open-ended when to is absent).
  activeAt: boolean;
};

export async function assignmentsFor(graph: Graph, projectId: string, role: string | null, atMs: number): Promise<AssignmentRow[]> {
  const reply = await graph.roQuery<Record<string, unknown>>(
    `MATCH (o:Ownership)-[:FOR_PROJECT]->(:Project {id: $project})
     WHERE $role IS NULL OR o.topic = $role
     MATCH (o)-[:ASSIGNS_TO]->(a)
     OPTIONAL MATCH (o)-[e:EVIDENCED_BY]->(k:Chunk)-[:PART_OF]->(doc:Document)
     WITH o, a, collect(${EVIDENCE}) AS evidence
     RETURN o.id AS claim_id, o.topic AS role, a.id AS assignee_id, a.name AS assignee_name, a.kind AS assignee_kind,
            o.role_exclusive AS exclusive,
            o.effective_from_ms AS from_ms, o.effective_from_value AS from_value, o.effective_from_precision AS from_precision,
            o.effective_to_ms AS to_ms, o.effective_to_value AS to_value, o.effective_to_precision AS to_precision,
            o.end_reason AS end_reason, o.ended_by AS ended_by, o.handoff_from AS handoff_from, evidence,
            (o.effective_from_ms <= $at AND (o.effective_to_ms IS NULL OR $at < o.effective_to_ms)) AS active_at
     ORDER BY from_ms, claim_id`,
    { params: { project: projectId, role, at: atMs } },
  );
  return (reply.data ?? []).map((row) => {
    const claimId = row.claim_id as string;
    const from = time(row.from_ms as number, row.from_value as string, row.from_precision as string);
    if (!from) throw new Error(`Ownership ${claimId} has no start`);
    return {
      claimId,
      role: row.role as string,
      assignee: { id: row.assignee_id as string, name: row.assignee_name as string, kind: row.assignee_kind as string },
      exclusive: row.exclusive === true,
      from,
      to: time(row.to_ms as number | null, row.to_value as string | null, row.to_precision as string | null),
      endReason: (row.end_reason as AssignmentRow["endReason"]) ?? null,
      endedBy: (row.ended_by as string | null) ?? null,
      handoffFrom: (row.handoff_from as string | null) ?? null,
      evidence: evidenceOf(claimId, row.evidence as RawEvidence[]),
      activeAt: row.active_at === true,
    };
  });
}

export type SearchRow = { chunkId: string; versionId: string; documentId: string; title: string; projectIds: string[] };

// Full-text matches on chunk bodies. `query` must already be sanitised (see fulltextQuery):
// RediSearch syntax lives inside the parameter, separate from Cypher parameterisation.
export async function fulltextChunks(graph: Graph, query: string, limit: number): Promise<SearchRow[]> {
  const reply = await graph.roQuery<{ chunk_id: string; version_id: string; document_id: string; title: string; project_ids: string[] | null }>(
    `CALL db.idx.fulltext.queryNodes('Chunk', $query) YIELD node, score
     MATCH (node)-[:PART_OF]->(d:Document)
     RETURN node.id AS chunk_id, d.id AS version_id, d.document_id AS document_id, d.title AS title, d.project_ids AS project_ids
     ORDER BY score DESC, chunk_id LIMIT $limit`,
    { params: { query, limit } },
  );
  return (reply.data ?? []).map((row) => ({ chunkId: row.chunk_id, versionId: row.version_id, documentId: row.document_id, title: row.title, projectIds: row.project_ids ?? [] }));
}

export async function nearestChunks(graph: Graph, vector: number[], limit: number): Promise<SearchRow[]> {
  const reply = await graph.roQuery<{ chunk_id: string; version_id: string; document_id: string; title: string; project_ids: string[] | null }>(
    `CALL db.idx.vector.queryNodes('Chunk', 'embedding', $limit, vecf32($vector)) YIELD node, score
     MATCH (node)-[:PART_OF]->(d:Document)
     RETURN node.id AS chunk_id, d.id AS version_id, d.document_id AS document_id, d.title AS title, d.project_ids AS project_ids
     ORDER BY score ASC, chunk_id`,
    { params: { vector, limit } },
  );
  return (reply.data ?? []).map((row) => ({ chunkId: row.chunk_id, versionId: row.version_id, documentId: row.document_id, title: row.title, projectIds: row.project_ids ?? [] }));
}

export type EvidencedClaimRow = { chunkId: string; claimId: string; kind: "decision" | "ownership" | "supersession"; projectId: string; topic: string };

// Bounded neighbourhood: the claims each hit chunk is evidence for.
export async function claimsEvidencedBy(graph: Graph, chunkIds: string[]): Promise<EvidencedClaimRow[]> {
  if (!chunkIds.length) return [];
  const reply = await graph.roQuery<{ chunk_id: string; claim_id: string; labels: string[]; project_id: string; topic: string }>(
    `MATCH (c:Claim)-[:EVIDENCED_BY]->(k:Chunk) WHERE k.id IN $ids
     RETURN DISTINCT k.id AS chunk_id, c.id AS claim_id, labels(c) AS labels, c.project_id AS project_id, c.topic AS topic
     ORDER BY chunk_id, claim_id`,
    { params: { ids: chunkIds } },
  );
  return (reply.data ?? []).map((row) => ({
    chunkId: row.chunk_id,
    claimId: row.claim_id,
    kind: row.labels.includes("Ownership") ? "ownership" : row.labels.includes("Supersession") ? "supersession" : "decision",
    projectId: row.project_id,
    topic: row.topic,
  }));
}
