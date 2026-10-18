import type pg from "pg";
import { claimEffectiveAt, claimSchema, type Claim } from "@/contracts/claims";

export type ClaimWriteResult = { inserted: number; updated: number; unchanged: number; retired: number };

// retire: claims of these origins that are absent from `claims` are marked rejected (never
// deleted), so earlier builds stay auditable.
export async function writeClaims(
  client: pg.PoolClient,
  claims: Claim[],
  retire: { origins: Claim["origin"][]; note: string } = { origins: ["structured", "fixture_reviewed"], note: "Removed from the reviewed claim set" },
): Promise<ClaimWriteResult> {
  const result: ClaimWriteResult = { inserted: 0, updated: 0, unchanged: 0, retired: 0 };

  // Claim IDs are stable identities: reusing one for a different kind of claim is an error.
  const existing = await client.query<{ claim_id: string; kind: string }>(
    "SELECT claim_id, kind FROM claims WHERE claim_id = ANY($1)",
    [claims.map((claim) => claim.claim_id)],
  );
  const existingKinds = new Map(existing.rows.map((row) => [row.claim_id, row.kind]));
  for (const claim of claims) {
    const kind = existingKinds.get(claim.claim_id);
    if (kind && kind !== claim.kind) throw new Error(`${claim.claim_id} already exists as a ${kind} claim`);
  }

  for (const claim of claims) {
    const write = await client.query<{ inserted: boolean }>(
      `INSERT INTO claims
         (claim_id, kind, project_id, topic, origin, review_status, review_note, payload, evidence, recorded_at, effective_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (claim_id) DO UPDATE SET
         project_id = EXCLUDED.project_id, topic = EXCLUDED.topic, origin = EXCLUDED.origin,
         review_status = EXCLUDED.review_status, review_note = EXCLUDED.review_note,
         payload = EXCLUDED.payload, evidence = EXCLUDED.evidence, recorded_at = EXCLUDED.recorded_at,
         effective_at = EXCLUDED.effective_at, updated_at = now()
       WHERE (claims.project_id, claims.topic, claims.origin, claims.review_status, claims.review_note,
              claims.payload, claims.evidence, claims.recorded_at, claims.effective_at)
         IS DISTINCT FROM
             (EXCLUDED.project_id, EXCLUDED.topic, EXCLUDED.origin, EXCLUDED.review_status, EXCLUDED.review_note,
              EXCLUDED.payload, EXCLUDED.evidence, EXCLUDED.recorded_at, EXCLUDED.effective_at)
       RETURNING (xmax = 0) AS inserted`,
      [
        claim.claim_id,
        claim.kind,
        claim.project_id,
        claim.topic,
        claim.origin,
        claim.review_status,
        claim.review_note,
        JSON.stringify(claim.payload),
        JSON.stringify(claim.evidence),
        JSON.stringify(claim.recorded_at),
        claimEffectiveAt(claim),
      ],
    );
    const row = write.rows[0];
    if (!row) result.unchanged++;
    else if (row.inserted) result.inserted++;
    else result.updated++;
  }

  const retired = await client.query(
    `UPDATE claims SET review_status = 'rejected', review_note = $3, updated_at = now()
     WHERE origin = ANY($2) AND review_status <> 'rejected' AND NOT (claim_id = ANY($1))`,
    [claims.map((claim) => claim.claim_id), retire.origins, retire.note],
  );
  result.retired = retired.rowCount ?? 0;
  return result;
}

export async function readApprovedClaims(db: pg.Pool | pg.PoolClient, origins: Claim["origin"][]): Promise<Claim[]> {
  const result = await db.query(
    `SELECT claim_id, kind, project_id, topic, origin, review_status, review_note, payload, evidence, recorded_at
     FROM claims WHERE review_status = 'approved' AND origin = ANY($1) ORDER BY claim_id`,
    [origins],
  );
  return result.rows.map((row) => claimSchema.parse(row));
}
