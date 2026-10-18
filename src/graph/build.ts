import { randomBytes } from "node:crypto";
import type { FalkorDB } from "falkordb";
import type pg from "pg";
import { readSnapshot, finishBuild, insertBuild, type Snapshot } from "@/graph/build.db";
import { graphName } from "@/graph/client";
import { deriveOwnershipIntervals, type OwnershipConflict } from "@/graph/ownership-intervals";
import { createIndexes, projectSnapshot } from "@/graph/project";
import { CHUNKER_VERSIONS } from "@/ingest/chunk";
import type { TopicRegistry } from "@/ingest/registry";
import type { Claim, OwnershipClaim } from "@/contracts/claims";

export const GRAPH_SCHEMA_VERSION = 1;

// Which reviewed claims a build projects. Fixture seeding and real extraction stay separate paths;
// structured roster claims belong to both.
export const CLAIM_SETS = {
  fixture: ["structured", "fixture_reviewed"],
  extracted: ["structured", "extracted"],
} as const satisfies Record<string, Claim["origin"][]>;
export type ClaimSet = keyof typeof CLAIM_SETS;

export type BuildOutcome = { buildId: string; graphName: string; conflicts: OwnershipConflict[] };

// e.g. b20261018t143005_3fa9: sortable by time, unique, and safe inside a graph name.
export function newBuildId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").toLowerCase();
  return `b${stamp}_${randomBytes(2).toString("hex")}`;
}

export function buildGraphName(buildId: string): string {
  return graphName(`build_${buildId}`);
}

// Projects approved Postgres records into a brand-new graph. Makes no model or embedding calls.
// Leaves the build "built" on success and "failed" (with its graph kept for inspection) otherwise.
export async function rebuildGraph(pool: pg.Pool, db: FalkorDB, topics: TopicRegistry, claimSet: ClaimSet = "fixture"): Promise<BuildOutcome> {
  const client = await pool.connect();
  let snapshot: Snapshot;
  try {
    snapshot = await readSnapshot(client, Object.values(CHUNKER_VERSIONS), [...CLAIM_SETS[claimSet]]);
  } finally {
    client.release();
  }
  assertSnapshotConsistent(snapshot);

  const isExclusive = (projectId: string, role: string) => topics.projects[projectId]?.ownership_roles[role]?.exclusive ?? false;
  const ownership = snapshot.claims.filter((claim): claim is OwnershipClaim => claim.kind === "ownership");
  const { intervals, conflicts } = deriveOwnershipIntervals(ownership, isExclusive);

  const buildId = newBuildId();
  const name = buildGraphName(buildId);
  if ((await db.list()).includes(name)) throw new Error(`Graph ${name} already exists; refusing to reuse it`);

  const evidenceEdges = snapshot.claims.reduce((sum, claim) => sum + claim.evidence.length, 0);
  const count = (kind: string) => snapshot.claims.filter((claim) => claim.kind === kind).length;
  await insertBuild(pool, {
    buildId,
    graphName: name,
    config: {
      schema_version: GRAPH_SCHEMA_VERSION,
      company_id: snapshot.companyId,
      chunker_versions: CHUNKER_VERSIONS,
      topics_revision: topics.revision,
      claim_set: claimSet,
      // Vector index and chunk embeddings arrive with the embedding cache (LOC-3).
      vectors: "absent",
    },
    selection: {
      versionIds: snapshot.versions.map((version) => version.versionId),
      claimIds: snapshot.claims.map((claim) => claim.claim_id),
      counts: {
        Person: snapshot.entities.filter((entity) => entity.kind === "person").length,
        Team: snapshot.entities.filter((entity) => entity.kind === "team").length,
        Project: snapshot.entities.filter((entity) => entity.kind === "project").length,
        Document: snapshot.versions.length,
        Chunk: snapshot.chunks.length,
        Decision: count("decision"),
        Ownership: count("ownership"),
        Supersession: count("supersession"),
        EVIDENCED_BY: evidenceEdges,
        SUPERSEDES: count("supersession"),
      },
    },
  });

  try {
    const graph = db.selectGraph(name);
    await createIndexes(graph);
    await projectSnapshot(graph, snapshot, new Map(intervals.map((interval) => [interval.claimId, interval])), isExclusive);
    await finishBuild(pool, buildId, "built", { integrity: { conflicts } });
  } catch (error) {
    await finishBuild(pool, buildId, "failed", { error: (error as Error).message });
    throw error;
  }
  return { buildId, graphName: name, conflicts };
}

// Fail before writing anything if approved claims cite chunks outside the selected versions, e.g.
// after a document changed but claims were not re-seeded.
function assertSnapshotConsistent(snapshot: Snapshot): void {
  const chunkIds = new Set(snapshot.chunks.map((chunk) => chunk.chunkId));
  const entityIds = new Set(snapshot.entities.map((entity) => entity.entityId));
  const problems: string[] = [];
  for (const claim of snapshot.claims) {
    for (const item of claim.evidence) {
      if (!chunkIds.has(item.chunk_id)) problems.push(`${claim.claim_id} cites ${item.chunk_id}, which is not in a selected version`);
    }
    if (!entityIds.has(claim.project_id)) problems.push(`${claim.claim_id} references unknown project ${claim.project_id}`);
  }
  // Supersessions and handoffs must point at claims inside the same projected set.
  const claimIds = new Set(snapshot.claims.map((claim) => claim.claim_id));
  for (const claim of snapshot.claims) {
    const refs =
      claim.kind === "supersession"
        ? [claim.payload.new_decision_id, claim.payload.old_decision_id]
        : claim.kind === "ownership" && claim.payload.handoff_from
          ? [claim.payload.handoff_from]
          : [];
    for (const ref of refs) if (!claimIds.has(ref)) problems.push(`${claim.claim_id} references ${ref}, which is not in this claim set`);
  }
  if (problems.length) throw new Error(`Snapshot is inconsistent; re-run pnpm seed:claims:\n  ${problems.join("\n  ")}`);
}
