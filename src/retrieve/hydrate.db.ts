import type pg from "pg";
import type { TimePoint } from "@/time/company-time";

export type ChunkSource = {
  chunkId: string;
  versionId: string;
  documentId: string;
  title: string;
  eventAt: TimePoint;
  headingPath: string[];
  body: string;
};

// Exact-ID lookup only: Postgres supplies source text for chunks the graph already returned.
export async function readChunkSources(db: pg.Pool, chunkIds: string[]): Promise<Map<string, ChunkSource>> {
  const result = await db.query<{
    chunk_id: string;
    version_id: string;
    document_id: string;
    title: string;
    event_at: TimePoint;
    heading_path: string[];
    body: string;
  }>(
    `SELECT c.chunk_id, v.version_id, v.document_id, v.title, v.event_at, c.heading_path, c.body
     FROM chunks c JOIN document_versions v ON v.version_id = c.version_id
     WHERE c.chunk_id = ANY($1)`,
    [chunkIds],
  );
  return new Map(
    result.rows.map((row) => [
      row.chunk_id,
      {
        chunkId: row.chunk_id,
        versionId: row.version_id,
        documentId: row.document_id,
        title: row.title,
        eventAt: row.event_at,
        headingPath: row.heading_path,
        body: row.body,
      },
    ]),
  );
}
