import { z } from "zod";
import { timePointSchema } from "@/time/company-time";

// Stored claim shapes, shared by seeding, graph projection, and graph tools.

export const CLAIM_ID = /^[a-z][a-z0-9-]{2,80}$/;
export const claimIdSchema = z.string().regex(CLAIM_ID, "lowercase letters, digits, and hyphens");

export const claimKindSchema = z.enum(["decision", "ownership", "supersession"]);
export type ClaimKind = z.infer<typeof claimKindSchema>;

// Review state of the claim record, independent of a decision's business lifecycle.
export const reviewStatusSchema = z.enum(["pending", "approved", "rejected"]);
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

export const claimOriginSchema = z.enum(["structured", "fixture_reviewed", "extracted"]);
export type ClaimOrigin = z.infer<typeof claimOriginSchema>;

// What a piece of evidence supports: evidence for one field does not prove another.
export const evidenceRoleSchema = z.enum([
  "decision",
  "proposal",
  "rationale",
  "decided_by",
  "assignment",
  "handoff",
  "replacement",
]);
export type EvidenceRole = z.infer<typeof evidenceRoleSchema>;

export const evidenceRefSchema = z.object({
  chunk_id: z.string(),
  version_id: z.string(),
  document_id: z.string(),
  role: evidenceRoleSchema,
  quote: z.string().min(1),
  // Offsets of the quote inside the chunk body.
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
});
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

export const decisionPayloadSchema = z.object({
  choice: z.string().min(1),
  title: z.string().min(1),
  lifecycle: z.enum(["proposed", "decided"]),
  proposed_at: timePointSchema.nullable(),
  decided_at: timePointSchema.nullable(),
  effective_at: timePointSchema.nullable(),
  // "decision_date" means the source gave no effective date, so the decision date is used.
  effective_basis: z.enum(["stated", "decision_date"]).nullable(),
  rationale: z.string().nullable(),
  decided_by: z.string().nullable(),
});
export type DecisionPayload = z.infer<typeof decisionPayloadSchema>;

export const ownershipPayloadSchema = z.object({
  assignee_id: z.string(),
  effective_from: timePointSchema,
  // Only an end date the source states; derived ends come from handoffs at projection time.
  effective_to: timePointSchema.nullable(),
  handoff_from: claimIdSchema.nullable(),
});
export type OwnershipPayload = z.infer<typeof ownershipPayloadSchema>;

export const supersessionPayloadSchema = z.object({
  new_decision_id: claimIdSchema,
  old_decision_id: claimIdSchema,
  effective_at: timePointSchema,
});
export type SupersessionPayload = z.infer<typeof supersessionPayloadSchema>;

const claimBase = {
  claim_id: claimIdSchema,
  project_id: z.string(),
  topic: z.string(),
  origin: claimOriginSchema,
  review_status: reviewStatusSchema,
  review_note: z.string().nullable(),
  // When the source recorded the claim (document or meeting-turn time).
  recorded_at: timePointSchema,
  evidence: z.array(evidenceRefSchema).min(1),
};

export const claimSchema = z.discriminatedUnion("kind", [
  z.object({ ...claimBase, kind: z.literal("decision"), payload: decisionPayloadSchema }),
  z.object({ ...claimBase, kind: z.literal("ownership"), payload: ownershipPayloadSchema }),
  z.object({ ...claimBase, kind: z.literal("supersession"), payload: supersessionPayloadSchema }),
]);
export type Claim = z.infer<typeof claimSchema>;
export type DecisionClaim = Extract<Claim, { kind: "decision" }>;
export type OwnershipClaim = Extract<Claim, { kind: "ownership" }>;
export type SupersessionClaim = Extract<Claim, { kind: "supersession" }>;

// The business time a claim takes effect, used for the typed effective_at column.
export function claimEffectiveAt(claim: Claim): string | null {
  switch (claim.kind) {
    case "decision":
      return claim.payload.effective_at?.utc ?? null;
    case "ownership":
      return claim.payload.effective_from.utc;
    case "supersession":
      return claim.payload.effective_at.utc;
  }
}
