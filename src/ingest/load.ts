import path from "node:path";
import type pg from "pg";
import { seedClaims } from "@/extract/seed-claims";
import type { ClaimWriteResult } from "@/extract/claims.db";
import { ingestSources, type IngestResult } from "@/ingest/ingest";
import { loadManifest, type Manifest } from "@/ingest/manifest";
import { readRegistry, readTopicRegistry } from "@/ingest/registry";
import { ensureCompany, writeRegistry, type RegistrySeedResult } from "@/ingest/registry.db";

export const DEFAULT_FIXTURE_ROOT = path.resolve("fixtures/lumen-freight");

export type LoadStep = "registry" | "ingest" | "claims";
export type LoadResult = {
  manifest: Manifest;
  registry?: RegistrySeedResult;
  ingest?: IngestResult;
  claims?: ClaimWriteResult;
};

// Runs the requested steps in one transaction, so a failed step leaves the database unchanged.
// Order matters: sources reference registry entities, and claims cite ingested chunks.
export async function loadFixtures(
  pool: pg.Pool,
  root: string = DEFAULT_FIXTURE_ROOT,
  steps: LoadStep[] = ["registry", "ingest", "claims"],
): Promise<LoadResult> {
  const manifest = await loadManifest(root);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result: LoadResult = { manifest };
    if (steps.includes("registry")) {
      await readTopicRegistry(manifest);
      await ensureCompany(client, manifest.company.id);
      result.registry = await writeRegistry(client, await readRegistry(manifest));
    }
    if (steps.includes("ingest")) result.ingest = await ingestSources(client, manifest);
    if (steps.includes("claims")) result.claims = await seedClaims(client, manifest);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
