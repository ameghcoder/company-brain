import type { Claim, EvidenceRole, OwnershipClaim } from "@/contracts/claims";
import type { TopicRegistry } from "@/ingest/registry";

export type KnownEntity = { kind: "person" | "team" | "project" };

const ALLOWED_ROLES: Record<Claim["kind"], EvidenceRole[]> = {
  decision: ["decision", "proposal", "rationale", "decided_by"],
  ownership: ["assignment", "handoff"],
  supersession: ["replacement"],
};

// Consistency rules applied before any claim is stored. Rejected claims only need a valid project
// and topic (they are kept for audit); pending and approved claims get every check, and references
// between claims must point at approved claims.
export function validateClaims(
  claims: Claim[],
  entities: Map<string, KnownEntity>,
  topics: TopicRegistry,
): string[] {
  const errors: string[] = [];
  const fail = (claim: Claim, message: string) => errors.push(`${claim.claim_id}: ${message}`);

  const seen = new Set<string>();
  for (const claim of claims) {
    if (seen.has(claim.claim_id)) fail(claim, "duplicate claim_id");
    seen.add(claim.claim_id);
  }

  const approved = new Map(claims.filter((claim) => claim.review_status === "approved").map((claim) => [claim.claim_id, claim]));

  for (const claim of claims) {
    if (entities.get(claim.project_id)?.kind !== "project") {
      fail(claim, `unknown project ${claim.project_id}`);
      continue;
    }
    const registry = topics.projects[claim.project_id];
    const topicKnown =
      claim.kind === "ownership"
        ? Boolean(registry?.ownership_roles[claim.topic])
        : Boolean(registry?.decision_topics[claim.topic]);
    if (!topicKnown) fail(claim, `topic ${claim.topic} is not a registered ${claim.kind === "ownership" ? "role" : "decision topic"} of ${claim.project_id}`);
    if (claim.review_status === "rejected") continue;

    const roles = new Set(claim.evidence.map((item) => item.role));
    for (const role of roles) {
      if (!ALLOWED_ROLES[claim.kind].includes(role)) fail(claim, `evidence role ${role} does not apply to a ${claim.kind}`);
    }
    const needRole = (role: EvidenceRole, why: string) => {
      if (!roles.has(role)) fail(claim, `${why} needs evidence with role ${role}`);
    };

    switch (claim.kind) {
      case "decision": {
        const payload = claim.payload;
        needRole(payload.lifecycle === "proposed" ? "proposal" : "decision", `a ${payload.lifecycle} decision`);
        if (payload.lifecycle === "proposed" && roles.has("decision")) fail(claim, "a proposal cannot cite decision evidence");
        if (payload.rationale !== null) needRole("rationale", "a stated rationale");
        if (payload.rationale === null && roles.has("rationale")) fail(claim, "rationale evidence without a rationale");
        if (payload.decided_by !== null) {
          needRole("decided_by", "decided_by");
          if (entities.get(payload.decided_by)?.kind !== "person") fail(claim, `decided_by ${payload.decided_by} is not a known person`);
        }
        break;
      }
      case "ownership": {
        const payload = claim.payload;
        needRole("assignment", "an ownership claim");
        const assignee = entities.get(payload.assignee_id)?.kind;
        if (assignee !== "person" && assignee !== "team") fail(claim, `assignee ${payload.assignee_id} is not a known person or team`);
        if (payload.effective_to && payload.effective_to.utc <= payload.effective_from.utc) {
          fail(claim, "effective_to must be after effective_from");
        }
        if (payload.handoff_from) {
          needRole("handoff", "a handoff");
          const previous = approved.get(payload.handoff_from);
          if (!previous || previous.kind !== "ownership") {
            fail(claim, `handoff_from ${payload.handoff_from} is not an approved ownership claim`);
          } else if (previous.project_id !== claim.project_id || previous.topic !== claim.topic) {
            fail(claim, `handoff_from ${payload.handoff_from} is for a different project or role`);
          } else if (previous.payload.effective_from.utc >= payload.effective_from.utc) {
            fail(claim, `handoff_from ${payload.handoff_from} does not start before this assignment`);
          }
        } else if (roles.has("handoff")) {
          fail(claim, "handoff evidence without handoff_from");
        }
        break;
      }
      case "supersession": {
        needRole("replacement", "a supersession");
        const { new_decision_id: newId, old_decision_id: oldId } = claim.payload;
        if (newId === oldId) fail(claim, "a decision cannot supersede itself");
        for (const [label, id] of [["new_decision", newId], ["old_decision", oldId]] as const) {
          const decision = approved.get(id);
          if (!decision || decision.kind !== "decision" || decision.payload.lifecycle !== "decided") {
            fail(claim, `${label} ${id} is not an approved decided decision`);
          } else if (decision.project_id !== claim.project_id || decision.topic !== claim.topic) {
            // Replacement is only valid within the same project and topic.
            fail(claim, `${label} ${id} is for ${decision.project_id}/${decision.topic}, not ${claim.project_id}/${claim.topic}`);
          }
        }
        break;
      }
    }
  }

  errors.push(...findSupersessionCycles(claims.filter((claim) => claim.review_status === "approved")));
  errors.push(...findHandoffCycles(claims.filter((claim): claim is OwnershipClaim => claim.kind === "ownership" && claim.review_status === "approved")));
  return errors;
}

function findSupersessionCycles(approved: Claim[]): string[] {
  const edges = new Map<string, string[]>();
  for (const claim of approved) {
    if (claim.kind !== "supersession") continue;
    const list = edges.get(claim.payload.new_decision_id) ?? [];
    list.push(claim.payload.old_decision_id);
    edges.set(claim.payload.new_decision_id, list);
  }
  return findCycles(edges).map((cycle) => `supersession cycle: ${cycle.join(" -> ")}`);
}

function findHandoffCycles(ownership: OwnershipClaim[]): string[] {
  const edges = new Map<string, string[]>();
  for (const claim of ownership) {
    if (claim.payload.handoff_from) edges.set(claim.claim_id, [claim.payload.handoff_from]);
  }
  return findCycles(edges).map((cycle) => `handoff cycle: ${cycle.join(" -> ")}`);
}

function findCycles(edges: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (node: string) => {
    if (state.get(node) === "done") return;
    if (state.get(node) === "visiting") {
      cycles.push([...stack.slice(stack.indexOf(node)), node]);
      return;
    }
    state.set(node, "visiting");
    stack.push(node);
    for (const next of edges.get(node) ?? []) visit(next);
    stack.pop();
    state.set(node, "done");
  };
  for (const node of [...edges.keys()].sort()) visit(node);
  return cycles;
}
