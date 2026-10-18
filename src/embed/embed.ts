import type pg from "pg";
import type { EmbeddingSettings } from "@/config/server-env";
import { insertVectors, readMissingInputs } from "@/embed/embed.db";
import { CHUNKER_VERSIONS } from "@/ingest/chunk";

export type Embedder = {
  model: string;
  dimensions: number;
  embed(inputs: string[]): Promise<number[][]>;
};

export const EMBED_BATCH_SIZE = 64;

export class InvalidEmbeddingError extends Error {
  override name = "InvalidEmbeddingError";
}

export function assertValidVector(vector: unknown, dimensions: number): asserts vector is number[] {
  if (!Array.isArray(vector) || vector.length !== dimensions) {
    throw new InvalidEmbeddingError(`expected ${dimensions} values, got ${Array.isArray(vector) ? vector.length : typeof vector}`);
  }
  if (!vector.every((value) => typeof value === "number" && Number.isFinite(value))) throw new InvalidEmbeddingError("vector has non-finite values");
}

export type EmbedResult = { missing: number; embedded: number; batches: number };

// Embeds only inputs with no cached vector for these settings. Each batch is validated in full
// before any of it is stored, so a bad response never leaves partial vectors behind.
export async function embedChunks(pool: pg.Pool, embedder: Embedder, settings: EmbeddingSettings): Promise<EmbedResult> {
  if (embedder.model !== settings.model || embedder.dimensions !== settings.dimensions) {
    throw new Error("Embedder does not match the configured embedding model and dimensions");
  }
  const missing = await readMissingInputs(pool, settings, Object.values(CHUNKER_VERSIONS));
  const result: EmbedResult = { missing: missing.length, embedded: 0, batches: 0 };
  for (let i = 0; i < missing.length; i += EMBED_BATCH_SIZE) {
    const batch = missing.slice(i, i + EMBED_BATCH_SIZE);
    const vectors = await embedder.embed(batch.map((item) => item.input));
    if (vectors.length !== batch.length) throw new InvalidEmbeddingError(`expected ${batch.length} vectors, got ${vectors.length}`);
    vectors.forEach((vector) => assertValidVector(vector, settings.dimensions));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      result.embedded += await insertVectors(client, settings, batch.map((item, index) => ({ inputHash: item.inputHash, vector: vectors[index] ?? [] })));
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    result.batches++;
  }
  return result;
}
