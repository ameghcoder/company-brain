import { readFile } from "node:fs/promises";
import { z } from "zod";
import { claimIdSchema, evidenceRoleSchema, reviewStatusSchema, type ClaimOrigin } from "@/contracts/claims";
import { chunkCsv } from "@/ingest/chunk";
import { parseCsv } from "@/ingest/csv";
import { resolveInside, type Manifest } from "@/ingest/manifest";

// A claim as a reviewer writes it: evidence cites a document and an exact quote, and times are
// company-local strings. Seeding turns drafts into stored claims.

const draftEvidenceSchema = z.object({
  document: z.string(),
  role: evidenceRoleSchema,
  quote: z.string().min(1),
});
export type DraftEvidence = z.infer<typeof draftEvidenceSchema>;

const localTime = z.string();
const draftBase = {
  claim_id: claimIdSchema,
  project: z.string(),
  topic: z.string(),
  review_status: reviewStatusSchema,
  review_note: z.string().optional(),
  evidence: z.array(draftEvidenceSchema).min(1),
};

const claimDraftSchema = z.discriminatedUnion("kind", [
  z.object({
    ...draftBase,
    kind: z.literal("decision"),
    lifecycle: z.enum(["proposed", "decided"]),
    choice: z.string().min(1),
    title: z.string().min(1),
    proposed_at: localTime.optional(),
    decided_at: localTime.optional(),
    effective_at: localTime.nullable().optional(),
    rationale: z.string().nullable(),
    decided_by: z.string().nullable(),
  }),
  z.object({
    ...draftBase,
    kind: z.literal("ownership"),
    assignee: z.string(),
    effective_from: localTime,
    effective_to: localTime.nullable(),
    handoff_from: claimIdSchema.nullable(),
  }),
  z.object({
    ...draftBase,
    kind: z.literal("supersession"),
    new_decision: claimIdSchema,
    old_decision: claimIdSchema,
    effective_at: localTime,
  }),
]);
export type ClaimDraft = z.infer<typeof claimDraftSchema> & { origin: ClaimOrigin };

export async function readFixtureDrafts(manifest: Manifest, relativePath: string): Promise<ClaimDraft[]> {
  const raw = JSON.parse(await readFile(resolveInside(manifest.root, relativePath), "utf8")) as { claims?: unknown };
  const claims = z.array(claimDraftSchema).parse(raw.claims);
  return claims.map((claim) => ({ ...claim, origin: "fixture_reviewed" as const }));
}

// Each assignments.csv row is a structured ownership record. It skips extraction but goes through
// the same evidence, identity, date, and consistency validation as prose claims.
export async function readStructuredDrafts(manifest: Manifest): Promise<ClaimDraft[]> {
  const sources = manifest.sources.filter((source) => source.document_type === "assignments");
  const drafts: ClaimDraft[] = [];
  for (const source of sources) {
    const raw = (await readFile(resolveInside(manifest.root, source.path), "utf8")).replace(/\r\n?/g, "\n");
    const records = parseCsv(raw);
    const bodies = chunkCsv(raw, source.title);
    records.forEach((record, index) => {
      const values = record.values;
      drafts.push({
        claim_id: `own-${values.assignment_id ?? ""}`,
        kind: "ownership",
        origin: "structured",
        project: values.project_id ?? "",
        topic: values.role ?? "",
        review_status: "approved",
        assignee: values.assignee_id ?? "",
        effective_from: values.effective_from ?? "",
        effective_to: values.effective_to || null,
        handoff_from: null,
        evidence: [{ document: source.document_id, role: "assignment", quote: bodies[index]?.body ?? "" }],
      });
    });
  }
  return drafts;
}
