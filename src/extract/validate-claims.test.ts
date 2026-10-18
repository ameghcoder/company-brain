import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Claim, EvidenceRef, EvidenceRole } from "@/contracts/claims";
import type { TopicRegistry } from "@/ingest/registry";
import { validateClaims, type KnownEntity } from "@/extract/validate-claims";
import { parseLocalTime } from "@/time/company-time";

const TZ = "America/New_York";
const at = (value: string) => parseLocalTime(value, TZ);
const evidence = (...roles: EvidenceRole[]): EvidenceRef[] =>
  roles.map((role) => ({ chunk_id: "c", version_id: "v", document_id: "d", role, quote: "q", start: 0, end: 1 }));

const entities = new Map<string, KnownEntity>([
  ["proj-a", { kind: "project" }],
  ["p-ann", { kind: "person" }],
  ["t-ops", { kind: "team" }],
]);
const topics: TopicRegistry = {
  revision: 1,
  projects: {
    "proj-a": {
      decision_topics: { "payments.provider": "Provider", "payments.fraud": "Fraud" },
      ownership_roles: { "migration.owner": { label: "Owner", exclusive: true } },
    },
  },
};

const base = { project_id: "proj-a", origin: "fixture_reviewed", review_status: "approved", review_note: null, recorded_at: at("2026-10-01") } as const;

function decision(id: string, topic = "payments.provider", overrides: Partial<Extract<Claim, { kind: "decision" }>["payload"]> = {}): Claim {
  return {
    ...base,
    claim_id: id,
    kind: "decision",
    topic,
    evidence: evidence("decision"),
    payload: {
      choice: id,
      title: id,
      lifecycle: "decided",
      proposed_at: null,
      decided_at: at("2026-10-01"),
      effective_at: at("2026-10-01"),
      effective_basis: "stated",
      rationale: null,
      decided_by: null,
      ...overrides,
    },
  };
}

function proposal(id: string): Claim {
  return {
    ...decision(id),
    evidence: evidence("proposal"),
    payload: {
      choice: id,
      title: id,
      lifecycle: "proposed",
      proposed_at: at("2026-09-03"),
      decided_at: null,
      effective_at: null,
      effective_basis: null,
      rationale: null,
      decided_by: null,
    },
  } as Claim;
}

function supersession(id: string, newId: string, oldId: string, topic = "payments.provider"): Claim {
  return {
    ...base,
    claim_id: id,
    kind: "supersession",
    topic,
    evidence: evidence("replacement"),
    payload: { new_decision_id: newId, old_decision_id: oldId, effective_at: at("2026-10-02") },
  };
}

function ownership(id: string, from: string, handoffFrom: string | null = null, assignee = "p-ann"): Claim {
  return {
    ...base,
    claim_id: id,
    kind: "ownership",
    topic: "migration.owner",
    evidence: handoffFrom ? evidence("assignment", "handoff") : evidence("assignment"),
    payload: { assignee_id: assignee, effective_from: at(from), effective_to: null, handoff_from: handoffFrom },
  };
}

describe("claim validation", () => {
  it("accepts a consistent set", () => {
    const claims = [
      decision("dec-old"),
      decision("dec-new"),
      supersession("sup-one", "dec-new", "dec-old"),
      ownership("own-first", "2026-09-01"),
      ownership("own-second", "2026-10-15", "own-first", "t-ops"),
    ];
    assert.deepEqual(validateClaims(claims, entities, topics), []);
  });

  it("rejects a supersession across topics", () => {
    const errors = validateClaims(
      [decision("dec-old"), decision("dec-fraud", "payments.fraud"), supersession("sup-x", "dec-fraud", "dec-old")],
      entities,
      topics,
    );
    assert.ok(errors.some((error) => /new_decision dec-fraud is for proj-a\/payments\.fraud/.test(error)), errors.join("\n"));
  });

  it("rejects self-supersession and cycles", () => {
    const self = validateClaims([decision("dec-a"), supersession("sup-self", "dec-a", "dec-a")], entities, topics);
    assert.ok(self.some((error) => /cannot supersede itself/.test(error)));

    const cycle = validateClaims(
      [decision("dec-a"), decision("dec-b"), supersession("sup-ab", "dec-a", "dec-b"), supersession("sup-ba", "dec-b", "dec-a")],
      entities,
      topics,
    );
    assert.ok(cycle.some((error) => /supersession cycle: dec-a -> dec-b -> dec-a/.test(error)), cycle.join("\n"));
  });

  it("rejects a proposal used as a replaced or replacing decision", () => {
    const errors = validateClaims([decision("dec-a"), proposal("prop-b"), supersession("sup-p", "prop-b", "dec-a")], entities, topics);
    assert.ok(errors.some((error) => /new_decision prop-b is not a decided decision that can be referenced/.test(error)), errors.join("\n"));
  });

  it("rejects unknown entities and topics outside the project registry", () => {
    const errors = validateClaims(
      [decision("dec-a", "crm.vendor"), ownership("own-x", "2026-09-01", null, "p-nobody"), decision("dec-b", "payments.provider", { decided_by: "p-ghost" })],
      entities,
      topics,
    );
    assert.ok(errors.some((error) => /topic crm\.vendor is not a registered decision topic/.test(error)));
    assert.ok(errors.some((error) => /assignee p-nobody is not a known person or team/.test(error)));
    assert.ok(errors.some((error) => /decided_by p-ghost is not a known person/.test(error)));
  });

  it("requires evidence for each asserted field", () => {
    const errors = validateClaims([decision("dec-a", "payments.provider", { rationale: "cheaper" })], entities, topics);
    assert.ok(errors.some((error) => /a stated rationale needs evidence with role rationale/.test(error)));
  });

  it("rejects handoffs that point backwards in time or at another role", () => {
    const errors = validateClaims([ownership("own-late", "2026-11-01"), ownership("own-early", "2026-10-01", "own-late")], entities, topics);
    assert.ok(errors.some((error) => /does not start before this assignment/.test(error)));
  });

  it("lets pending claims reference pending ones but keeps the approved set self-contained", () => {
    const pendingOld = { ...decision("dec-old"), review_status: "pending" as const };
    assert.deepEqual(validateClaims([pendingOld, { ...decision("dec-new"), review_status: "pending" as const }, { ...supersession("sup-p", "dec-new", "dec-old"), review_status: "pending" as const }], entities, topics), []);
    const errors = validateClaims([pendingOld, decision("dec-new"), supersession("sup-a", "dec-new", "dec-old")], entities, topics);
    assert.ok(errors.some((error) => /sup-a: old_decision dec-old is not approved/.test(error)), errors.join("\n"));
  });

  it("only checks project and topic for rejected claims", () => {
    const rejected = { ...decision("dec-r", "payments.provider", { decided_by: "p-ghost" }), review_status: "rejected" as const };
    assert.deepEqual(validateClaims([rejected], entities, topics), []);
  });
});
