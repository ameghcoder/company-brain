import type pg from "pg";
import { claimSchema, type Claim } from "@/contracts/claims";
import type { TimePoint } from "@/time/company-time";

export type SnapshotEntity = { entityId: string; kind: "person" | "team" | "project"; canonicalName: string };
export type SnapshotVersion = {
  versionId: string;
  documentId: string;
  documentType: string;
  sourceType: string;
  title: string;
  authorId: string | null;
  eventAt: TimePoint;
};
export type SnapshotChunk = {
  chunkId: string;
  versionId: string;
  documentId: string;
  chunkerVersion: string;
  position: number;
  headingPath: string[];
  body: string;
  startOffset: number;
  endOffset: number;
};
export type Snapshot = {
  companyId: string;
  entities: SnapshotEntity[];
  versions: SnapshotVersion[];
  chunks: SnapshotChunk[];
  claims: Claim[];
};

// One consistent read of everything a build projects: entities, each document's selected
// version and its chunks (current chunker versions only), and approved claims.
export async function readSnapshot(client: pg.PoolClient, chunkerVersions: string[], claimOrigins: Claim["origin"][]): Promise<Snapshot> {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const company = await client.query<{ company_id: string }>("SELECT company_id FROM app_state");
    if (company.rowCount !== 1) throw new Error("Expected exactly one company in app_state; run pnpm data:load");

    const entities = await client.query<{ entity_id: string; kind: SnapshotEntity["kind"]; canonical_name: string }>(
      "SELECT entity_id, kind, canonical_name FROM entities ORDER BY entity_id",
    );
    const versions = await client.query<{
      version_id: string;
      document_id: string;
      document_type: string;
      source_type: string;
      title: string;
      author_id: string | null;
      event_at: TimePoint;
    }>(
      `SELECT v.version_id, d.document_id, d.document_type, s.source_type, v.title, v.author_id, v.event_at
       FROM documents d
       JOIN sources s ON s.source_id = d.source_id
       JOIN document_versions v ON v.version_id = d.selected_version_id
       ORDER BY d.document_id`,
    );
    const chunks = await client.query<{
      chunk_id: string;
      version_id: string;
      document_id: string;
      chunker_version: string;
      position: number;
      heading_path: string[];
      body: string;
      start_offset: number;
      end_offset: number;
    }>(
      `SELECT c.chunk_id, c.version_id, d.document_id, c.chunker_version, c.position, c.heading_path, c.body,
              c.start_offset, c.end_offset
       FROM documents d
       JOIN chunks c ON c.version_id = d.selected_version_id AND c.chunker_version = ANY($1)
       ORDER BY d.document_id, c.position`,
      [chunkerVersions],
    );
    const claims = await client.query(
      `SELECT claim_id, kind, project_id, topic, origin, review_status, review_note, payload, evidence, recorded_at
       FROM claims WHERE review_status = 'approved' AND origin = ANY($1) ORDER BY claim_id`,
      [claimOrigins],
    );
    await client.query("COMMIT");

    return {
      companyId: company.rows[0]?.company_id ?? "",
      entities: entities.rows.map((row) => ({ entityId: row.entity_id, kind: row.kind, canonicalName: row.canonical_name })),
      versions: versions.rows.map((row) => ({
        versionId: row.version_id,
        documentId: row.document_id,
        documentType: row.document_type,
        sourceType: row.source_type,
        title: row.title,
        authorId: row.author_id,
        eventAt: row.event_at,
      })),
      chunks: chunks.rows.map((row) => ({
        chunkId: row.chunk_id,
        versionId: row.version_id,
        documentId: row.document_id,
        chunkerVersion: row.chunker_version,
        position: row.position,
        headingPath: row.heading_path,
        body: row.body,
        startOffset: row.start_offset,
        endOffset: row.end_offset,
      })),
      claims: claims.rows.map((row) => claimSchema.parse(row)),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export type BuildState = "building" | "built" | "checked" | "failed";
export type BuildRow = {
  buildId: string;
  graphName: string;
  state: BuildState;
  config: Record<string, unknown>;
  selection: BuildSelection;
  integrity: unknown;
  error: string | null;
};

// What a build contains, recorded so checks compare the graph against the build's own snapshot
// rather than whatever Postgres holds later.
export type BuildSelection = {
  versionIds: string[];
  claimIds: string[];
  counts: Record<string, number>;
};

export async function insertBuild(
  db: pg.Pool,
  build: { buildId: string; graphName: string; config: Record<string, unknown>; selection: BuildSelection },
): Promise<void> {
  await db.query(
    "INSERT INTO graph_builds (build_id, graph_name, state, config, selection) VALUES ($1, $2, 'building', $3, $4)",
    [build.buildId, build.graphName, JSON.stringify(build.config), JSON.stringify(build.selection)],
  );
}

export async function finishBuild(
  db: pg.Pool,
  buildId: string,
  state: Exclude<BuildState, "building">,
  details: { integrity?: unknown; error?: string },
): Promise<void> {
  await db.query(
    `UPDATE graph_builds SET state = $2, integrity = COALESCE($3, integrity), error = $4, finished_at = now()
     WHERE build_id = $1`,
    [buildId, state, details.integrity === undefined ? null : JSON.stringify(details.integrity), details.error ?? null],
  );
}

export async function readBuild(db: pg.Pool | pg.PoolClient, buildId: string): Promise<BuildRow | undefined> {
  const result = await db.query<{
    build_id: string;
    graph_name: string;
    state: BuildState;
    config: Record<string, unknown>;
    selection: BuildSelection;
    integrity: unknown;
    error: string | null;
  }>("SELECT build_id, graph_name, state, config, selection, integrity, error FROM graph_builds WHERE build_id = $1", [buildId]);
  const row = result.rows[0];
  return (
    row && {
      buildId: row.build_id,
      graphName: row.graph_name,
      state: row.state,
      config: row.config,
      selection: row.selection,
      integrity: row.integrity,
      error: row.error,
    }
  );
}

export type ActiveBuild = { companyId: string; buildId: string; graphName: string };

export async function readActiveBuild(db: pg.Pool | pg.PoolClient): Promise<ActiveBuild | undefined> {
  const result = await db.query<{ company_id: string; build_id: string; graph_name: string }>(
    `SELECT a.company_id, b.build_id, b.graph_name
     FROM app_state a JOIN graph_builds b ON b.build_id = a.active_build_id`,
  );
  const row = result.rows[0];
  return row && { companyId: row.company_id, buildId: row.build_id, graphName: row.graph_name };
}

// The pointer moves only to a build that passed its checks; the row lock serialises activations.
export async function setActiveBuild(client: pg.PoolClient, buildId: string): Promise<{ previous: string | null }> {
  await client.query("BEGIN");
  try {
    const build = await client.query<{ state: BuildState }>("SELECT state FROM graph_builds WHERE build_id = $1 FOR UPDATE", [buildId]);
    const state = build.rows[0]?.state;
    if (state !== "checked") throw new Error(`Build ${buildId} is ${state ?? "unknown"}; only a checked build can be activated`);
    const current = await client.query<{ active_build_id: string | null }>("SELECT active_build_id FROM app_state FOR UPDATE");
    if (current.rowCount !== 1) throw new Error("Expected exactly one company in app_state");
    await client.query("UPDATE app_state SET active_build_id = $1, updated_at = now()", [buildId]);
    await client.query("COMMIT");
    return { previous: current.rows[0]?.active_build_id ?? null };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function readChunkBodies(db: pg.Pool, chunkIds: string[]): Promise<Map<string, string>> {
  const result = await db.query<{ chunk_id: string; body: string }>("SELECT chunk_id, body FROM chunks WHERE chunk_id = ANY($1)", [chunkIds]);
  return new Map(result.rows.map((row) => [row.chunk_id, row.body]));
}
