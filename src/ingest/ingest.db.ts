import type pg from "pg";
import type { ChunkDraft, Turn } from "@/ingest/chunk";
import type { SourceEntry } from "@/ingest/manifest";
import type { TimePoint } from "@/time/company-time";

export async function upsertDocument(client: pg.PoolClient, source: SourceEntry): Promise<void> {
  await client.query(
    `INSERT INTO sources (source_id, source_type, origin_path) VALUES ($1, $2, $3)
     ON CONFLICT (source_id) DO UPDATE SET origin_path = EXCLUDED.origin_path
       WHERE sources.source_type = EXCLUDED.source_type`,
    [source.document_id, source.source_type, source.path],
  );
  await client.query(
    `INSERT INTO documents (document_id, source_id, document_type) VALUES ($1, $1, $2)
     ON CONFLICT (document_id) DO NOTHING`,
    [source.document_id, source.document_type],
  );
}

export type VersionRow = {
  versionId: string;
  documentId: string;
  contentHash: string;
  rawText: string;
  title: string;
  authorId: string | null;
  eventAt: TimePoint;
  projectIds: string[];
  metadata: Record<string, unknown>;
};

// Versions are immutable: an existing version_id is left exactly as it is.
export async function insertVersion(client: pg.PoolClient, version: VersionRow): Promise<number> {
  const result = await client.query(
    `INSERT INTO document_versions
       (version_id, document_id, content_hash, raw_text, title, author_id, event_at, event_at_utc, project_ids, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (version_id) DO NOTHING`,
    [
      version.versionId,
      version.documentId,
      version.contentHash,
      version.rawText,
      version.title,
      version.authorId,
      JSON.stringify(version.eventAt),
      version.eventAt.utc,
      version.projectIds,
      JSON.stringify(version.metadata),
    ],
  );
  return result.rowCount ?? 0;
}

export type ChunkRow = {
  chunkId: string;
  versionId: string;
  chunkerVersion: string;
  draft: Omit<ChunkDraft, "turns"> & { turns: (Turn & { speaker_id: string | null })[] };
  embeddingInput: string;
  embeddingInputHash: string;
};

export async function insertChunks(client: pg.PoolClient, rows: ChunkRow[]): Promise<number> {
  let created = 0;
  for (const row of rows) {
    const result = await client.query(
      `INSERT INTO chunks
         (chunk_id, version_id, chunker_version, position, heading_path, body, start_offset, end_offset,
          token_estimate, turns, embedding_input, embedding_input_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (chunk_id) DO NOTHING`,
      [
        row.chunkId,
        row.versionId,
        row.chunkerVersion,
        row.draft.position,
        row.draft.headingPath,
        row.draft.body,
        row.draft.start,
        row.draft.end,
        row.draft.tokenEstimate,
        JSON.stringify(row.draft.turns),
        row.embeddingInput,
        row.embeddingInputHash,
      ],
    );
    created += result.rowCount ?? 0;
  }
  return created;
}

export async function selectVersion(client: pg.PoolClient, documentId: string, versionId: string): Promise<number> {
  const result = await client.query(
    `UPDATE documents SET selected_version_id = $2, updated_at = now()
     WHERE document_id = $1 AND selected_version_id IS DISTINCT FROM $2`,
    [documentId, versionId],
  );
  return result.rowCount ?? 0;
}

export type SelectedChunk = {
  chunkId: string;
  versionId: string;
  documentId: string;
  body: string;
  eventAt: TimePoint;
  turns: (Turn & { speaker_id: string | null })[];
};

// Chunks of each document's selected version, produced by the given chunker versions.
export async function readSelectedChunks(db: pg.Pool | pg.PoolClient, chunkerVersions: string[]): Promise<SelectedChunk[]> {
  const result = await db.query<{
    chunk_id: string;
    version_id: string;
    document_id: string;
    body: string;
    event_at: TimePoint;
    turns: (Turn & { speaker_id: string | null })[];
  }>(
    `SELECT c.chunk_id, c.version_id, d.document_id, c.body, v.event_at, c.turns
     FROM documents d
     JOIN document_versions v ON v.version_id = d.selected_version_id
     JOIN chunks c ON c.version_id = v.version_id AND c.chunker_version = ANY($1)
     ORDER BY d.document_id, c.position`,
    [chunkerVersions],
  );
  return result.rows.map((row) => ({
    chunkId: row.chunk_id,
    versionId: row.version_id,
    documentId: row.document_id,
    body: row.body,
    eventAt: row.event_at,
    turns: row.turns,
  }));
}
