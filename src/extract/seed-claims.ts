import type pg from "pg";
import type { Claim } from "@/contracts/claims";
import { buildClaim, type SourceChunk } from "@/extract/build-claims";
import { readFixtureDrafts, readStructuredDrafts } from "@/extract/claim-drafts";
import { writeClaims, type ClaimWriteResult } from "@/extract/claims.db";
import { validateClaims } from "@/extract/validate-claims";
import { CHUNKER_VERSIONS } from "@/ingest/chunk";
import { readSelectedChunks } from "@/ingest/ingest.db";
import type { Manifest } from "@/ingest/manifest";
import { readTopicRegistry } from "@/ingest/registry";
import { readEntities } from "@/ingest/registry.db";

export const REVIEWED_CLAIMS_PATH = "claims/reviewed-claims.json";

export class ClaimValidationError extends Error {
  override name = "ClaimValidationError";
  constructor(readonly problems: string[]) {
    super(`Claim seeding rejected ${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  }
}

// All-or-nothing: every draft must build and validate before any claim is written.
export async function seedClaims(
  client: pg.PoolClient,
  manifest: Manifest,
  reviewedPath = REVIEWED_CLAIMS_PATH,
): Promise<ClaimWriteResult> {
  const drafts = [...(await readStructuredDrafts(manifest)), ...(await readFixtureDrafts(manifest, reviewedPath))];
  const chunks = await readSelectedChunks(client, Object.values(CHUNKER_VERSIONS));
  const chunksByDocument = new Map<string, SourceChunk[]>();
  for (const chunk of chunks) {
    const list = chunksByDocument.get(chunk.documentId) ?? [];
    list.push(chunk);
    chunksByDocument.set(chunk.documentId, list);
  }

  const problems: string[] = [];
  const claims: Claim[] = [];
  for (const draft of drafts) {
    const built = buildClaim(draft, chunksByDocument, manifest.company.timezone);
    if (built.ok) claims.push(built.claim);
    else problems.push(...built.errors.map((error) => `${draft.claim_id}: ${error}`));
  }

  const entities = new Map((await readEntities(client)).map((entity) => [entity.entityId, entity]));
  problems.push(...validateClaims(claims, entities, await readTopicRegistry(manifest)));
  if (problems.length) throw new ClaimValidationError(problems);

  return writeClaims(client, claims);
}
