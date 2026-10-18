import type { Claim, DecisionClaim, OwnershipClaim, SupersessionClaim } from "@/contracts/claims";
import type { LinkHints } from "@/extract/interpret";

export type LinkProblem = { claimId: string; message: string };

const sameChoice = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// Turns the model's by-name link requests into explicit claims. A link is made only to exactly
// one earlier claim in the same project and topic; anything else goes to review. A newer date
// alone never creates a replacement.
export function linkClaims(
  extracted: Claim[],
  hints: Map<string, LinkHints>,
  existingOwnership: OwnershipClaim[],
): { claims: Claim[]; problems: LinkProblem[] } {
  const problems: LinkProblem[] = [];
  const decisions = extracted.filter((claim): claim is DecisionClaim => claim.kind === "decision" && claim.payload.lifecycle === "decided");
  const supersessions: SupersessionClaim[] = [];

  for (const decision of decisions) {
    const wanted = hints.get(decision.claim_id)?.replacesChoice;
    if (!wanted) continue;
    const decidedAt = decision.payload.decided_at?.utc ?? "";
    const candidates = decisions.filter(
      (other) =>
        other.claim_id !== decision.claim_id &&
        other.project_id === decision.project_id &&
        other.topic === decision.topic &&
        sameChoice(other.payload.choice, wanted) &&
        (other.payload.decided_at?.utc ?? "") < decidedAt,
    );
    const [old, ...more] = candidates;
    if (!old || more.length) {
      problems.push({
        claimId: decision.claim_id,
        message: old
          ? `replaces "${wanted}" matches ${candidates.length} earlier decisions on ${decision.topic}: ${candidates.map((c) => c.claim_id).join(", ")}`
          : `replaces "${wanted}" but no earlier decided decision on ${decision.project_id}/${decision.topic} has that choice`,
      });
      continue;
    }
    const effectiveAt = decision.payload.effective_at;
    if (!effectiveAt) continue;
    supersessions.push({
      claim_id: `${decision.claim_id}-r`,
      kind: "supersession",
      project_id: decision.project_id,
      topic: decision.topic,
      origin: "extracted",
      review_status: "pending",
      review_note: null,
      recorded_at: decision.recorded_at,
      // The sentence that adopts the new choice is the one that states the replacement.
      evidence: decision.evidence.filter((item) => item.role === "decision").map((item) => ({ ...item, role: "replacement" as const })),
      payload: { new_decision_id: decision.claim_id, old_decision_id: old.claim_id, effective_at: effectiveAt },
    });
  }

  const ownership = extracted.filter((claim): claim is OwnershipClaim => claim.kind === "ownership");
  const linkedOwnership = ownership.map((claim): OwnershipClaim => {
    const previousHolder = hints.get(claim.claim_id)?.takesOverFrom;
    if (!previousHolder) return claim;
    const candidates = [...existingOwnership, ...ownership].filter(
      (other) =>
        other.claim_id !== claim.claim_id &&
        other.project_id === claim.project_id &&
        other.topic === claim.topic &&
        other.payload.assignee_id === previousHolder &&
        other.payload.effective_from.utc < claim.payload.effective_from.utc,
    );
    const [previous, ...more] = candidates;
    if (!previous || more.length) {
      problems.push({
        claimId: claim.claim_id,
        message: previous
          ? `takes over from ${previousHolder}, who has ${candidates.length} earlier ${claim.topic} assignments`
          : `takes over from ${previousHolder}, but no earlier ${claim.project_id}/${claim.topic} assignment for them exists`,
      });
      return claim;
    }
    const hasHandoffEvidence = claim.evidence.some((item) => item.role === "handoff");
    return {
      ...claim,
      payload: { ...claim.payload, handoff_from: previous.claim_id },
      // The takeover sentence is the evidence for both the assignment and the handoff.
      evidence: hasHandoffEvidence
        ? claim.evidence
        : [...claim.evidence, ...claim.evidence.filter((item) => item.role === "assignment").map((item) => ({ ...item, role: "handoff" as const }))],
    };
  });

  const others = extracted.filter((claim) => claim.kind !== "ownership");
  return { claims: [...others, ...linkedOwnership, ...supersessions], problems };
}
