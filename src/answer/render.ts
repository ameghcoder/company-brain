import type {
  Assignment,
  ChangesFacts,
  DecisionFact,
  ExplainFacts,
  LocalTime,
  OwnerFacts,
  TimelineFacts,
  ToolResponse,
} from "@/contracts/graph-tools";

// Deterministic plain-text rendering of verified tool results. It states only what the facts say
// and is the fallback answer when no model is involved or a model's answer fails its checks.

const when = (time: LocalTime | null) => (time ? time.value.replace("T", " ") : "unknown");
const who = (item: Assignment) => `${item.assignee.name} (${item.assignee.id})`;
const cite = (evidence: { document_id: string }[]) => {
  const docs = [...new Set(evidence.map((item) => item.document_id))];
  return docs.length ? ` [${docs.join(", ")}]` : "";
};

function decisionLine(decision: DecisionFact): string {
  const effective = decision.effective_basis === "decision_date" ? `${when(decision.effective_at)} (no separate effective date recorded)` : when(decision.effective_at);
  return `${decision.choice}: decided ${when(decision.decided_at)}, effective ${effective}${cite(decision.evidence.filter((e) => e.role === "decision"))}`;
}

export function renderResponse(response: ToolResponse): string[] {
  const lines = [`outcome: ${response.outcome}${response.build_id ? ` (build ${response.build_id})` : ""}`];
  const facts = response.facts;
  if (facts) {
    switch (response.intent) {
      case "owner": {
        const owner = facts as OwnerFacts;
        for (const item of owner.current) lines.push(`- holds ${owner.role}: ${who(item)} since ${when(item.from)}${cite(item.evidence)}`);
        if (owner.previous) lines.push(`- before that: ${who(owner.previous)} from ${when(owner.previous.from)} to ${when(owner.previous.to)}${cite(owner.previous.evidence)}`);
        if (owner.scheduled_successor) lines.push(`- scheduled: ${who(owner.scheduled_successor)} from ${when(owner.scheduled_successor.from)}${cite(owner.scheduled_successor.evidence)}`);
        break;
      }
      case "explain": {
        const explain = facts as ExplainFacts;
        if (explain.decision) {
          const decision = explain.decision;
          lines.push(`- current: ${decisionLine(decision)}`);
          lines.push(`- decided by: ${decision.decided_by ? `${decision.decided_by.name}${cite(decision.evidence.filter((e) => e.role === "decided_by"))}` : "not recorded"}`);
          lines.push(`- rationale: ${decision.rationale ? `${decision.rationale}${cite(decision.evidence.filter((e) => e.role === "rationale"))}` : "not recorded in the sources"}`);
        }
        for (const item of explain.supersedes) lines.push(`- replaced ${decisionLine(item.decision)}; replacement effective ${when(item.replacement.effective_at)}${cite(item.replacement.evidence)}`);
        if (explain.scheduled_replacement) {
          const next = explain.scheduled_replacement;
          lines.push(`- scheduled: replaced by ${next.new_decision.choice} from ${when(next.effective_at)}${cite(next.evidence)}`);
        }
        for (const proposal of explain.open_proposals) lines.push(`- open proposal (not a decision): ${proposal.choice}, raised ${when(proposal.proposed_at)}${cite(proposal.evidence)}`);
        for (const decision of explain.conflicting) lines.push(`- conflicting: ${decisionLine(decision)}`);
        break;
      }
      case "changes": {
        const changes = facts as ChangesFacts;
        for (const item of changes.replacements) {
          lines.push(`- ${item.topic}: ${item.old_decision.choice} -> ${item.new_decision.choice}, effective ${when(item.effective_at)}${cite(item.evidence)}`);
        }
        for (const item of changes.newly_effective_decisions) lines.push(`- ${item.topic}: ${decisionLine(item)}`);
        for (const item of changes.ownership_transfers) {
          lines.push(`- ${item.role}: ${item.from_assignment ? who(item.from_assignment) : "unknown"} -> ${who(item.to_assignment)}, from ${when(item.effective_at)}${cite(item.to_assignment.evidence)}`);
        }
        for (const item of changes.ownership_starts) lines.push(`- ${item.claim_id}: ${who(item)} starts ${when(item.from)}${cite(item.evidence)}`);
        break;
      }
      case "timeline": {
        for (const event of (facts as TimelineFacts).events) {
          const at = when(event.at);
          switch (event.type) {
            case "decision":
              lines.push(`- ${at} decision on ${event.topic}: ${event.decision.choice}${cite(event.decision.evidence)}`);
              break;
            case "proposal":
              lines.push(`- ${at} proposal on ${event.topic} (not decided): ${event.decision.choice}${cite(event.decision.evidence)}`);
              break;
            case "replacement":
              lines.push(`- ${at} ${event.topic}: ${event.replacement.old_decision.choice} replaced by ${event.replacement.new_decision.choice}${cite(event.replacement.evidence)}`);
              break;
            case "ownership_start":
              lines.push(`- ${at} ${event.role}: ${who(event.assignment)} starts${cite(event.assignment.evidence)}`);
              break;
            case "ownership_transfer":
              lines.push(`- ${at} ${event.role}: ${event.transfer.from_assignment ? who(event.transfer.from_assignment) : "unknown"} -> ${who(event.transfer.to_assignment)}${cite(event.transfer.to_assignment.evidence)}`);
              break;
            case "ownership_end":
              lines.push(`- ${at} ${event.role}: ${who(event.assignment)} ends${cite(event.assignment.evidence)}`);
              break;
          }
        }
        break;
      }
      case "resolve_alias":
        break;
    }
  }
  for (const note of response.notes) lines.push(`note: ${note}`);
  if (response.truncated) lines.push("note: results were truncated");
  for (const source of response.sources) {
    for (const excerpt of source.excerpts) lines.push(`  > [${source.document_id}] (${excerpt.role}) "${excerpt.text}"`);
  }
  return lines;
}
