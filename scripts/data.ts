import { ClaimValidationError } from "@/extract/seed-claims";
import { closePool, getPool } from "@/db/pool";
import { loadFixtures, type LoadStep } from "@/ingest/load";

// Usage: tsx scripts/data.ts <registry|ingest|claims|load>. Never calls a model provider.
const STEPS: Record<string, LoadStep[]> = {
  registry: ["registry"],
  ingest: ["ingest"],
  claims: ["claims"],
  load: ["registry", "ingest", "claims"],
};

const command = process.argv[2] ?? "";
const steps = STEPS[command];
if (!steps) {
  console.error(`usage: tsx scripts/data.ts <${Object.keys(STEPS).join("|")}>`);
  process.exit(2);
}

try {
  const result = await loadFixtures(getPool(), undefined, steps);
  console.log(`fixture set: ${result.manifest.company.name} (${result.manifest.sources.length} sources)`);
  if (result.registry) console.log(`registry: ${result.registry.entitiesUpserted} entities changed, ${result.registry.aliases} aliases`);
  if (result.ingest) {
    const r = result.ingest;
    console.log(`ingest: ${r.documents} documents, ${r.versionsCreated} new versions, ${r.chunksCreated} new chunks, ${r.selectionsChanged} selections changed`);
  }
  if (result.claims) {
    const r = result.claims;
    console.log(`claims: ${r.inserted} inserted, ${r.updated} updated, ${r.unchanged} unchanged, ${r.retired} retired`);
  }
} catch (error) {
  if (error instanceof ClaimValidationError) console.error(error.message);
  else console.error(`data ${command} failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
