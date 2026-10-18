import { z } from "zod";
import { evidenceRoleSchema } from "@/contracts/claims";
import { parseInstant } from "@/time/company-time";

// Inputs are validated here before any graph query runs; the server, not a planner, fills in
// the pinned build and graph name.

const projectId = z.string().regex(/^proj-[a-z0-9-]{1,60}$/, "project id like proj-atlas");
const topicKey = z.string().regex(/^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/, "topic key like payments.provider");
const instant = z.string().refine((value) => {
  try {
    parseInstant(value);
    return true;
  } catch {
    return false;
  }
}, "ISO instant with an explicit offset");

export const ownerRequestSchema = z.object({ intent: z.literal("owner"), project: projectId, role: topicKey, at: instant });
export const explainRequestSchema = z.object({ intent: z.literal("explain"), project: projectId, topic: topicKey, at: instant });
export const changesRequestSchema = z
  .object({ intent: z.literal("changes"), project: projectId, topic: topicKey.optional(), from: instant, to: instant })
  .refine((request) => parseInstant(request.from) < parseInstant(request.to), "from must be before to");
export const timelineRequestSchema = z
  .object({ intent: z.literal("timeline"), project: projectId, topic: topicKey.optional(), from: instant.optional(), to: instant.optional() })
  .refine((request) => !request.from || !request.to || parseInstant(request.from) < parseInstant(request.to), "from must be before to");
// Finds which registered topics the records discuss for some words; it never answers by itself.
export const searchRequestSchema = z.object({
  intent: z.literal("search"),
  project: projectId.optional(),
  text: z.string().trim().min(2).max(200),
});

export const resolveAliasRequestSchema = z.object({
  intent: z.literal("resolve_alias"),
  alias: z.string().min(1).max(100),
  kind: z.enum(["person", "team", "project"]).optional(),
});

export const toolRequestSchema = z.union([
  ownerRequestSchema,
  explainRequestSchema,
  changesRequestSchema,
  timelineRequestSchema,
  searchRequestSchema,
  resolveAliasRequestSchema,
]);
export type ToolRequest = z.infer<typeof toolRequestSchema>;
export type OwnerRequest = z.infer<typeof ownerRequestSchema>;
export type ExplainRequest = z.infer<typeof explainRequestSchema>;
export type ChangesRequest = z.infer<typeof changesRequestSchema>;
export type TimelineRequest = z.infer<typeof timelineRequestSchema>;
export type ResolveAliasRequest = z.infer<typeof resolveAliasRequestSchema>;
export type SearchRequest = z.infer<typeof searchRequestSchema>;

export const outcomeSchema = z.enum([
  "answered",
  "partial",
  "needs_clarification",
  "conflicting_evidence",
  "insufficient_evidence",
  "unavailable",
]);
export type Outcome = z.infer<typeof outcomeSchema>;

export type EvidenceItem = {
  claim_id: string;
  chunk_id: string;
  document_id: string;
  version_id: string;
  role: z.infer<typeof evidenceRoleSchema>;
  start: number;
  end: number;
};

// Source text for an evidence item, hydrated from Postgres by exact chunk ID.
export type SourceExcerpt = {
  chunk_id: string;
  document_id: string;
  version_id: string;
  title: string;
  event_date: string;
  heading_path: string[];
  excerpts: { claim_id: string; role: EvidenceItem["role"]; text: string }[];
};

// A graph edge that supplied a fact, between stable application IDs.
export type PathEdge = { from: string; rel: string; to: string };

export type LocalTime = { ms: number; value: string; precision: string };

export type Assignment = {
  claim_id: string;
  assignee: { id: string; name: string; kind: string };
  from: LocalTime;
  to: LocalTime | null;
  end_reason: "stated" | "handoff" | null;
  evidence: EvidenceItem[];
};

export type OwnerFacts = {
  project: string;
  role: string;
  at: string;
  exclusive: boolean;
  current: Assignment[];
  previous: Assignment | null;
  scheduled_successor: Assignment | null;
};

export type DecisionFact = {
  claim_id: string;
  topic: string;
  choice: string;
  title: string;
  lifecycle: "proposed" | "decided";
  proposed_at: LocalTime | null;
  decided_at: LocalTime | null;
  effective_at: LocalTime | null;
  effective_basis: "stated" | "decision_date" | null;
  // null means the sources record no rationale; it is unknown, not empty.
  rationale: string | null;
  decided_by: { id: string; name: string } | null;
  evidence: EvidenceItem[];
};

export type Replacement = {
  claim_id: string;
  topic: string;
  effective_at: LocalTime;
  new_decision: DecisionFact;
  old_decision: DecisionFact;
  evidence: EvidenceItem[];
};

export type ExplainFacts = {
  project: string;
  topic: string;
  at: string;
  status: "current" | "none_current" | "conflict";
  decision: DecisionFact | null;
  // Older decisions this one replaced, newest first.
  supersedes: { decision: DecisionFact; replacement: Replacement }[];
  scheduled_replacement: Replacement | null;
  open_proposals: DecisionFact[];
  conflicting: DecisionFact[];
};

export type OwnershipTransfer = {
  claim_id: string;
  role: string;
  effective_at: LocalTime;
  from_assignment: Assignment | null;
  to_assignment: Assignment;
};

export type ChangesFacts = {
  project: string;
  topic: string | null;
  from: string;
  to: string;
  replacements: Replacement[];
  newly_effective_decisions: DecisionFact[];
  ownership_transfers: OwnershipTransfer[];
  ownership_starts: Assignment[];
};

export type TimelineEvent =
  | { type: "decision"; at: LocalTime; topic: string; decision: DecisionFact }
  | { type: "proposal"; at: LocalTime; topic: string; decision: DecisionFact }
  | { type: "replacement"; at: LocalTime; topic: string; replacement: Replacement }
  | { type: "ownership_start"; at: LocalTime; role: string; assignment: Assignment }
  | { type: "ownership_transfer"; at: LocalTime; role: string; transfer: OwnershipTransfer }
  | { type: "ownership_end"; at: LocalTime; role: string; assignment: Assignment };

export type TimelineFacts = { project: string; topic: string | null; events: TimelineEvent[] };

export type AliasFacts = { alias: string; candidates: { id: string; name: string; kind: string }[] };

export type SearchHit = {
  chunk_id: string;
  document_id: string;
  title: string;
  fulltext_rank: number | null;
  vector_rank: number | null;
  rrf: number;
};

export type SearchTopic = {
  project_id: string;
  topic: string;
  kind: "decision" | "ownership";
  claim_ids: string[];
  chunk_ids: string[];
  rrf: number;
};

export type SearchFacts = {
  text: string;
  project: string | null;
  // Chunks with a full-text match; only these can select topics.
  hits: SearchHit[];
  // Vector-only neighbours: related reading, never evidence that a topic is meant.
  related: SearchHit[];
  topics: SearchTopic[];
  incomplete: string[];
};

type ToolFacts = {
  owner: OwnerFacts;
  explain: ExplainFacts;
  changes: ChangesFacts;
  timeline: TimelineFacts;
  search: SearchFacts;
  resolve_alias: AliasFacts;
};

export type ToolResponse<I extends keyof ToolFacts = keyof ToolFacts> = {
  intent: I;
  build_id: string | null;
  outcome: Outcome;
  facts: ToolFacts[I] | null;
  paths: PathEdge[];
  sources: SourceExcerpt[];
  notes: string[];
  truncated: boolean;
};
