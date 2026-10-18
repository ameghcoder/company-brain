import type pg from "pg";
import type { ExtractionConfig } from "@/extract/cache-key";
import type { WindowDocument } from "@/extract/windows";
import type { TimePoint } from "@/time/company-time";

type Db = pg.Pool | pg.PoolClient;

// Selected versions of prose documents (Markdown and meetings) with their current chunks.
// Structured CSV sources never go through extraction.
export async function readProseDocuments(db: Db, chunkerVersions: string[]): Promise<WindowDocument[]> {
  const result = await db.query<{
    document_id: string;
    version_id: string;
    document_type: string;
    title: string;
    author_id: string | null;
    event_at: TimePoint;
    project_ids: string[];
    metadata: { participants?: string[] };
    chunks: { chunk_id: string; body: string; heading_path: string[] }[];
  }>(
    `SELECT d.document_id, v.version_id, d.document_type, v.title, v.author_id, v.event_at, v.project_ids, v.metadata,
            json_agg(json_build_object('chunk_id', c.chunk_id, 'body', c.body, 'heading_path', c.heading_path) ORDER BY c.position) AS chunks
     FROM documents d
     JOIN sources s ON s.source_id = d.source_id AND s.source_type IN ('markdown', 'meeting')
     JOIN document_versions v ON v.version_id = d.selected_version_id
     JOIN chunks c ON c.version_id = v.version_id AND c.chunker_version = ANY($1)
     GROUP BY d.document_id, v.version_id, d.document_type, v.title, v.author_id, v.event_at, v.project_ids, v.metadata
     ORDER BY d.document_id`,
    [chunkerVersions],
  );
  return result.rows.map((row) => ({
    documentId: row.document_id,
    versionId: row.version_id,
    documentType: row.document_type,
    title: row.title,
    authorId: row.author_id,
    eventAt: row.event_at,
    projectIds: row.project_ids,
    participants: row.metadata.participants ?? [],
    chunks: row.chunks.map((chunk) => ({ chunkId: chunk.chunk_id, body: chunk.body, headingPath: chunk.heading_path })),
  }));
}

export async function readRegistryEntities(db: Db): Promise<{ id: string; kind: string; name: string; aliases: string[] }[]> {
  const result = await db.query<{ entity_id: string; kind: string; canonical_name: string; aliases: string[] }>(
    `SELECT e.entity_id, e.kind, e.canonical_name, coalesce(array_agg(a.alias ORDER BY a.alias) FILTER (WHERE a.alias IS NOT NULL), '{}') AS aliases
     FROM entities e LEFT JOIN entity_aliases a ON a.entity_id = e.entity_id
     GROUP BY e.entity_id, e.kind, e.canonical_name ORDER BY e.entity_id`,
  );
  return result.rows.map((row) => ({ id: row.entity_id, kind: row.kind, name: row.canonical_name, aliases: row.aliases }));
}

export type RunStatus = "failed" | "invalid" | "parsed";
export type RunRow = {
  runId: string;
  documentId: string;
  versionId: string;
  windowIndex: number;
  windowHash: string;
  status: RunStatus;
  rawOutput: string | null;
  servedModel: string | null;
  error: string | null;
  attempts: number;
};

export async function readRuns(db: Db, runIds: string[]): Promise<Map<string, RunRow>> {
  const result = await db.query<{
    run_id: string;
    document_id: string;
    version_id: string;
    window_index: number;
    window_hash: string;
    status: RunStatus;
    raw_output: string | null;
    served_model: string | null;
    error: string | null;
    attempts: number;
  }>(
    `SELECT run_id, document_id, version_id, window_index, window_hash, status, raw_output, served_model, error, attempts
     FROM extraction_runs WHERE run_id = ANY($1)`,
    [runIds],
  );
  return new Map(
    result.rows.map((row) => [
      row.run_id,
      {
        runId: row.run_id,
        documentId: row.document_id,
        versionId: row.version_id,
        windowIndex: row.window_index,
        windowHash: row.window_hash,
        status: row.status,
        rawOutput: row.raw_output,
        servedModel: row.served_model,
        error: row.error,
        attempts: row.attempts,
      },
    ]),
  );
}

// Records one attempt. Called with the raw output before it is parsed, then again with the
// parse outcome, so a crash in between still leaves the response on disk.
export async function recordRunAttempt(
  db: Db,
  run: {
    runId: string;
    documentId: string;
    versionId: string;
    windowIndex: number;
    windowHash: string;
    config: ExtractionConfig;
    status: RunStatus;
    rawOutput: string | null;
    servedModel: string | null;
    error: string | null;
    newAttempt: boolean;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO extraction_runs
       (run_id, document_id, version_id, window_index, window_hash, config, status, raw_output, served_model, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (run_id) DO UPDATE SET
       status = EXCLUDED.status, raw_output = EXCLUDED.raw_output, served_model = EXCLUDED.served_model,
       error = EXCLUDED.error, updated_at = now(),
       attempts = extraction_runs.attempts + CASE WHEN $11 THEN 1 ELSE 0 END`,
    [
      run.runId,
      run.documentId,
      run.versionId,
      run.windowIndex,
      run.windowHash,
      JSON.stringify(run.config),
      run.status,
      run.rawOutput,
      run.servedModel,
      run.error,
      run.newAttempt,
    ],
  );
}
