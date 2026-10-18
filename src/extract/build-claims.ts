import type { Claim, EvidenceRef, EvidenceRole } from "@/contracts/claims";
import type { ClaimDraft } from "@/extract/claim-drafts";
import { resolveEvidence, type EvidenceChunk } from "@/extract/resolve-evidence";
import { parseLocalTime, type TimePoint } from "@/time/company-time";

export type SourceChunk = EvidenceChunk & { eventAt: TimePoint };

export type BuildResult = { ok: true; claim: Claim } | { ok: false; errors: string[] };

// The evidence role that anchors when a claim was recorded.
const PRIMARY_ROLES: EvidenceRole[] = ["decision", "proposal", "assignment", "replacement"];

export function buildClaim(draft: ClaimDraft, chunksByDocument: Map<string, SourceChunk[]>, timezone: string): BuildResult {
  const errors: string[] = [];
  const at = (label: string, value: string): TimePoint | null => {
    try {
      return parseLocalTime(value, timezone);
    } catch (error) {
      errors.push(`${label}: ${(error as Error).message}`);
      return null;
    }
  };

  const evidence: EvidenceRef[] = [];
  for (const item of draft.evidence) {
    const resolved = resolveEvidence(item, chunksByDocument.get(item.document) ?? []);
    if (resolved.ok) evidence.push(resolved.evidence);
    else errors.push(`evidence (${item.role}): ${resolved.error}`);
  }

  // recorded_at is when the source recorded the claim, taken from the primary evidence's document.
  const primary = evidence.find((item) => PRIMARY_ROLES.includes(item.role)) ?? evidence[0];
  const recordedAt = primary
    ? chunksByDocument.get(primary.document_id)?.find((chunk) => chunk.chunkId === primary.chunk_id)?.eventAt
    : undefined;

  const base = {
    claim_id: draft.claim_id,
    project_id: draft.project,
    topic: draft.topic,
    origin: draft.origin,
    review_status: draft.review_status,
    review_note: draft.review_note ?? null,
    evidence,
  };

  let claim: Claim | undefined;
  switch (draft.kind) {
    case "decision": {
      if (draft.lifecycle === "proposed") {
        if (draft.decided_at || draft.effective_at) errors.push("a proposal has no decided_at or effective_at");
        if (!draft.proposed_at) errors.push("a proposal needs proposed_at");
        const proposedAt = draft.proposed_at ? at("proposed_at", draft.proposed_at) : null;
        claim = {
          ...base,
          kind: "decision",
          recorded_at: recordedAt ?? proposedAt ?? placeholderTime(timezone),
          payload: {
            choice: draft.choice,
            title: draft.title,
            lifecycle: "proposed",
            proposed_at: proposedAt,
            decided_at: null,
            effective_at: null,
            effective_basis: null,
            rationale: draft.rationale,
            decided_by: draft.decided_by,
          },
        };
      } else {
        if (draft.proposed_at) errors.push("a decided claim has no proposed_at");
        if (!draft.decided_at) errors.push("a decided claim needs decided_at");
        const decidedAt = draft.decided_at ? at("decided_at", draft.decided_at) : null;
        const stated = draft.effective_at ? at("effective_at", draft.effective_at) : null;
        claim = {
          ...base,
          kind: "decision",
          recorded_at: recordedAt ?? decidedAt ?? placeholderTime(timezone),
          payload: {
            choice: draft.choice,
            title: draft.title,
            lifecycle: "decided",
            proposed_at: null,
            decided_at: decidedAt,
            // Without a stated effective date the decision takes effect when it was made; the basis
            // field records that this was not stated by the source.
            effective_at: stated ?? decidedAt,
            effective_basis: draft.effective_at ? "stated" : "decision_date",
            rationale: draft.rationale,
            decided_by: draft.decided_by,
          },
        };
      }
      break;
    }
    case "ownership": {
      const from = at("effective_from", draft.effective_from);
      const to = draft.effective_to ? at("effective_to", draft.effective_to) : null;
      if (from) {
        claim = {
          ...base,
          kind: "ownership",
          recorded_at: recordedAt ?? from,
          payload: { assignee_id: draft.assignee, effective_from: from, effective_to: to, handoff_from: draft.handoff_from },
        };
      }
      break;
    }
    case "supersession": {
      const effective = at("effective_at", draft.effective_at);
      if (effective) {
        claim = {
          ...base,
          kind: "supersession",
          recorded_at: recordedAt ?? effective,
          payload: { new_decision_id: draft.new_decision, old_decision_id: draft.old_decision, effective_at: effective },
        };
      }
      break;
    }
  }

  if (errors.length || !claim) return { ok: false, errors: errors.length ? errors : ["could not build claim"] };
  return { ok: true, claim };
}

// Only reached when evidence failed to resolve, in which case the claim is rejected anyway.
function placeholderTime(timezone: string): TimePoint {
  return { value: "unknown", precision: "day", timezone, utc: new Date(0).toISOString() };
}
