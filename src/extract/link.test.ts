import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DecisionClaim, EvidenceRef, EvidenceRole, OwnershipClaim } from "@/contracts/claims";
import type { LinkHints } from "@/extract/interpret";
import { linkClaims } from "@/extract/link";
import { parseLocalTime } from "@/time/company-time";

const TZ = "America/New_York";
const at = (value: string) => parseLocalTime(value, TZ);
const evidence = (role: EvidenceRole, quote: string): EvidenceRef => ({ chunk_id: "doc@v/c/0", version_id: "doc@v", document_id: "doc", role, quote, start: 0, end: quote.length });
const decision = (id: string, choice: string, day: string, items: EvidenceRef[]): DecisionClaim => ({
  claim_id: id,
  kind: "decision",
  project_id: "proj-atlas",
  topic: "payments.provider",
  origin: "extracted",
  review_status: "pending",
  review_note: null,
  recorded_at: at(day),
  evidence: items,
  payload: { choice, title: choice, lifecycle: "decided", proposed_at: null, decided_at: at(day), effective_at: at(day), effective_basis: "stated", rationale: null, decided_by: null },
});
const owner = (id: string, assignee: string, day: string, items: EvidenceRef[]): OwnershipClaim => ({
  claim_id: id,
  kind: "ownership",
  project_id: "proj-cobalt",
  topic: "pipeline.owner",
  origin: "extracted",
  review_status: "pending",
  review_note: null,
  recorded_at: at(day),
  evidence: items,
  payload: { assignee_id: assignee, effective_from: at(day), effective_to: null, handoff_from: null },
});
const hints = (entries: [string, LinkHints][]) => new Map(entries);

// Real gpt-5-mini runs (#22) labelled the replacement sentence on the decision itself, which
// validation rejects for a decision; the replacement belongs to the derived supersession claim.
describe("linking cleans evidence roles the model put on the wrong claim", () => {
  it("moves replacement evidence from a linked decision to its supersession", () => {
    const old = decision("x-old-d0", "Braintree", "2026-08-12", [evidence("decision", "Atlas will use Braintree.")]);
    const replacing = decision("x-new-d0", "Stripe", "2026-10-02", [evidence("decision", "Atlas moves to Stripe."), evidence("replacement", "Braintree stays read-only until December.")]);
    const { claims, problems } = linkClaims([old, replacing], hints([["x-new-d0", { replacesChoice: "Braintree", takesOverFrom: null }]]), []);
    const linked = claims.find((claim) => claim.claim_id === "x-new-d0");
    const supersession = claims.find((claim) => claim.kind === "supersession");
    assert.deepEqual(linked?.evidence.map((item) => item.role), ["decision"]);
    assert.deepEqual(supersession?.evidence.map((item) => [item.role, item.quote]), [["replacement", "Braintree stays read-only until December."]]);
    assert.deepEqual(problems, []);
  });

  it("drops replacement evidence, with a note, when no earlier decision matches", () => {
    const sift = decision("x-sift-d0", "Sift", "2026-10-05", [evidence("decision", "Atlas will screen card payments with Sift."), evidence("replacement", "This replaces the manual review queue.")]);
    const { claims, problems } = linkClaims([sift], hints([["x-sift-d0", { replacesChoice: "manual review queue", takesOverFrom: null }]]), []);
    assert.deepEqual(claims[0]?.evidence.map((item) => item.role), ["decision"]);
    assert.ok(problems.some((problem) => problem.claimId === "x-sift-d0" && /dropped 1 replacement evidence/.test(problem.message)), JSON.stringify(problems));
  });

  it("drops handoff evidence, with a note, from an assignment that hands off from no one", () => {
    const taylor = owner("x-taylor-o0", "p-taylor-brooks", "2026-09-22", [evidence("assignment", "Taylor Brooks owns the pipeline."), evidence("handoff", "I'll run the backlog from here.")]);
    const { claims, problems } = linkClaims([taylor], hints([]), []);
    assert.deepEqual(claims[0]?.evidence.map((item) => item.role), ["assignment"]);
    assert.ok(problems.some((problem) => /dropped 1 handoff evidence/.test(problem.message)), JSON.stringify(problems));
  });

  it("never leaves a claim without evidence", () => {
    const onlyReplacement = decision("x-only-d0", "Sift", "2026-10-05", [evidence("replacement", "This replaces the manual queue.")]);
    const { claims } = linkClaims([onlyReplacement], hints([]), []);
    assert.equal(claims[0]?.evidence.length, 1, "kept as is for review; validation reports it");
  });

  it("notes an assignment that restates an open assignment to the same holder", () => {
    const register = owner("own-asg-003", "t-data", "2026-07-01", [evidence("assignment", "asg-003,proj-cobalt,warehouse.owner,t-data")]);
    const restated = owner("x-roadmap-o1", "t-data", "2026-09-20", [evidence("assignment", "Warehouse platform: Data Platform team.")]);
    const { claims, problems } = linkClaims([restated], hints([]), [register]);
    assert.equal(claims.length, 1, "kept for the reviewer to decide");
    assert.ok(problems.some((problem) => problem.claimId === "x-roadmap-o1" && /restates own-asg-003/.test(problem.message)), JSON.stringify(problems));
    const successor = owner("x-next-o0", "p-jordan-kim", "2026-09-20", [evidence("assignment", "Pipeline owner: Jordan Kim.")]);
    assert.deepEqual(linkClaims([successor], hints([]), [register]).problems, [], "a different holder is not a restatement");
  });
});
