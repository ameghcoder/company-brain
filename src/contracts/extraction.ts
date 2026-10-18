import { z } from "zod";
import { evidenceRoleSchema } from "@/contracts/claims";

// What the extraction model must return for one document window. Bump the schema version for
// any change here: it is part of the extraction cache key, so old runs are never reused silently.
export const EXTRACTION_SCHEMA_VERSION = "extraction-v1";

// Strict objects with every field required (nullable instead of optional) match the rules for
// strict structured outputs, and make "not stated" an explicit null rather than an omission.
const evidenceSchema = z.strictObject({
  chunk_id: z.string(),
  quote: z.string(),
  supports: evidenceRoleSchema,
});

const decisionProposalSchema = z.strictObject({
  project_id: z.string(),
  topic: z.string(),
  status: z.enum(["decided", "proposed"]),
  choice: z.string(),
  title: z.string(),
  decided_on: z.string().nullable(),
  effective_on: z.string().nullable(),
  rationale: z.string().nullable(),
  decided_by: z.string().nullable(),
  replaces_choice: z.string().nullable(),
  evidence: z.array(evidenceSchema),
  uncertainty: z.string().nullable(),
});

const ownershipProposalSchema = z.strictObject({
  project_id: z.string(),
  role: z.string(),
  assignee_id: z.string(),
  effective_from: z.string().nullable(),
  effective_to: z.string().nullable(),
  takes_over_from: z.string().nullable(),
  evidence: z.array(evidenceSchema),
  uncertainty: z.string().nullable(),
});

const unresolvedMentionSchema = z.strictObject({
  text: z.string(),
  chunk_id: z.string(),
  candidate_ids: z.array(z.string()),
  note: z.string().nullable(),
});

export const extractionOutputSchema = z.strictObject({
  decisions: z.array(decisionProposalSchema),
  ownership: z.array(ownershipProposalSchema),
  unresolved_mentions: z.array(unresolvedMentionSchema),
});
export type ExtractionOutput = z.infer<typeof extractionOutputSchema>;
export type DecisionProposal = z.infer<typeof decisionProposalSchema>;
export type OwnershipProposal = z.infer<typeof ownershipProposalSchema>;
export type ProposalEvidence = z.infer<typeof evidenceSchema>;
export type UnresolvedMention = z.infer<typeof unresolvedMentionSchema>;

export function extractionJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(extractionOutputSchema) as Record<string, unknown>;
}
