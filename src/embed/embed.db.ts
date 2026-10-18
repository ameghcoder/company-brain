import type pg from "pg";
import type { EmbeddingSettings } from "@/config/server-env";

type Db = pg.Pool | pg.PoolClient;

export type EmbeddingInput = { inputHash: string; input: string };

// Distinct embedding inputs of the selected chunks that have no cached vector for these settings.
export async function readMissingInputs(db: Db, settings: EmbeddingSettings, chunkerVersions: string[]): Promise<EmbeddingInput[]> {
  const result = await db.query<{ input_hash: string; input: string }>(
    `SELECT DISTINCT ON (c.embedding_input_hash) c.embedding_input_hash AS input_hash, c.embedding_input AS input
     FROM documents d
     JOIN chunks c ON c.version_id = d.selected_version_id AND c.chunker_version = ANY($3)
     LEFT JOIN embedding_cache e ON e.input_hash = c.embedding_input_hash AND e.model = $1 AND e.dimensions = $2
     WHERE e.input_hash IS NULL
     ORDER BY c.embedding_input_hash`,
    [settings.model, settings.dimensions, chunkerVersions],
  );
  return result.rows.map((row) => ({ inputHash: row.input_hash, input: row.input }));
}

export async function insertVectors(client: pg.PoolClient, settings: EmbeddingSettings, rows: { inputHash: string; vector: number[] }[]): Promise<number> {
  let inserted = 0;
  for (const row of rows) {
    const result = await client.query(
      `INSERT INTO embedding_cache (input_hash, model, dimensions, vector) VALUES ($1, $2, $3, $4)
       ON CONFLICT (input_hash, model, dimensions) DO NOTHING`,
      [row.inputHash, settings.model, settings.dimensions, row.vector],
    );
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}

export async function readVectors(db: Db, settings: EmbeddingSettings, inputHashes: string[]): Promise<Map<string, number[]>> {
  const result = await db.query<{ input_hash: string; vector: number[] }>(
    "SELECT input_hash, vector FROM embedding_cache WHERE model = $1 AND dimensions = $2 AND input_hash = ANY($3)",
    [settings.model, settings.dimensions, inputHashes],
  );
  return new Map(result.rows.map((row) => [row.input_hash, row.vector.map(Number)]));
}
