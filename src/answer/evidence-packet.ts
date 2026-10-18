import type {
  Assignment,
  ChangesFacts,
  DecisionFact,
  EvidenceItem,
  ExplainFacts,
  OwnerFacts,
  Replacement,
  SourceExcerpt,
  TimelineFacts,
  ToolResponse,
} from "@/contracts/graph-tools";
import { estimateTokens } from "@/ingest/chunk";
import { localDateString, parseInstant } from "@/time/company-time";

// The only material the answer model sees: facts derived deterministically from verified tool
// output, each with the citations that support it. The model may restate these, nothing else.

export const PACKET_TOKEN_BUDGET = 6_000;
const EXCERPT_MAX_CHARS = 400;

export type FactKind =
  | "owner"
  | "conflicting_owner"
  | "previous_owner"
  | "scheduled_owner"
  | "decision"
  | "conflicting_decision"
  | "replaced_decision"
  | "scheduled_replacement"
  | "proposal"
  | "replacement"
  | "decision_effective"
  | "ownership_transfer"
  | "ownership_start"
  | "event"
  | "no_record";

// Facts every answer must cover; the others may be omitted when not asked about.
export const MAIN_FACT_KINDS: FactKind[] = [
  "owner",
  "conflicting_owner",
  "decision",
  "conflicting_decision",
  "replacement",
  "decision_effective",
  "ownership_transfer",
  "ownership_start",
  "event",
  "no_record",
];

export type PacketFact = {
  fact_id: string;
  step: number;
  kind: FactKind;
  // A deterministic sentence stating exactly this fact; also the fallback answer text.
  summary: string;
  // Entity IDs, names, choices, and dates the fact asserts; checks compare answer text to these.
  entities: { id: string; name: string }[];
  choices: string[];
  dates: string[];
  citation_ids: string[];
  // Fields the sources leave unknown for this fact, e.g. "rationale".
  unknown: string[];
  conflict_group: string | null;
};

export type PacketCitation = {
  citation_id: string;
  claim_id: string;
  chunk_id: string;
  document_id: string;
  title: string;
  role: EvidenceItem["role"];
  excerpt: string;
};

export type EvidencePacket = {
  question: string;
  as_of: string;
  build_id: string | null;
  facts: PacketFact[];
  citations: PacketCitation[];
  missing: string[];
  conflicts: string[];
  truncated: boolean;
};

const day = (value: string | null | undefined) => (value ? value.slice(0, 10) : null);

export type PacketInput = {
  question: string;
  asOfLocal: string;
  buildId: string | null;
  steps: { response: ToolResponse | null; notes: string[] }[];
  // Canonical names by entity ID, for readable summaries and name checks.
  names: Map<string, string>;
  timezone: string;
};

export function buildEvidencePacket({ question, asOfLocal, buildId, steps, names, timezone }: PacketInput): EvidencePacket {
  const facts: PacketFact[] = [];
  const citations: PacketCitation[] = [];
  const missing: string[] = [];
  const conflicts: string[] = [];
  const citationIds = new Map<string, string>();
  let truncated = false;

  const cite = (evidence: EvidenceItem[], sources: SourceExcerpt[], roles?: EvidenceItem["role"][]): string[] => {
    const ids: string[] = [];
    for (const item of evidence.filter((e) => !roles || roles.includes(e.role))) {
      const key = `${item.claim_id}|${item.chunk_id}|${item.role}|${item.start}`;
      let id = citationIds.get(key);
      if (!id) {
        const source = sources.find((s) => s.chunk_id === item.chunk_id);
        const excerpt = source?.excerpts.find((e) => e.claim_id === item.claim_id && e.role === item.role && e.start === item.start)?.text ?? "";
        id = `c${citations.length + 1}`;
        citationIds.set(key, id);
        citations.push({
          citation_id: id,
          claim_id: item.claim_id,
          chunk_id: item.chunk_id,
          document_id: item.document_id,
          title: source?.title ?? item.document_id,
          role: item.role,
          excerpt: excerpt.length > EXCERPT_MAX_CHARS ? `${excerpt.slice(0, EXCERPT_MAX_CHARS)}…` : excerpt,
        });
      }
      if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  };
  // The project a step is about is always an allowed name for that step's facts.
  let project: { id: string; name: string } | null = null;
  const add = (fact: Omit<PacketFact, "fact_id">) =>
    facts.push({ ...fact, entities: project ? [project, ...fact.entities] : fact.entities, fact_id: `f${facts.length + 1}` });
  const who = (item: Assignment) => ({ id: item.assignee.id, name: item.assignee.name });

  steps.forEach(({ response, notes }, step) => {
    if (!response?.facts) {
      // A step with nothing recorded is itself a fact the answer must state, without citations.
      project = null;
      const note = notes[0] ?? response?.notes[0] ?? "Nothing relevant is recorded.";
      add({ step, kind: "no_record", summary: note, entities: [], choices: [], dates: [], citation_ids: [], unknown: [], conflict_group: null });
      return;
    }
    const sources = response.sources;
    const projectId = (response.facts as { project?: string }).project;
    project = projectId ? { id: projectId, name: names.get(projectId) ?? projectId } : null;
    if (response.truncated) truncated = true;
    switch (response.intent) {
      case "owner":
        ownerFacts(response.facts as OwnerFacts, step);
        break;
      case "explain":
        explainFacts(response.facts as ExplainFacts, step);
        break;
      case "changes":
        changesFacts(response.facts as ChangesFacts, step);
        break;
      case "timeline":
        timelineFacts(response.facts as TimelineFacts, step);
        break;
      case "resolve_alias":
        break;
    }
    if (response.outcome === "insufficient_evidence") {
      add({ step, kind: "no_record", summary: response.notes[0] ?? "Nothing relevant is recorded.", entities: [], choices: [], dates: [], citation_ids: [], unknown: [], conflict_group: null });
    }

    function ownerFacts(owner: OwnerFacts, step: number) {
      // `at` is a UTC instant; the date a person means is the company-local one.
      const at = localDateString(parseInstant(owner.at), timezone);
      if (owner.current.length > 1 && owner.exclusive) {
        const group = `owner-${step}`;
        conflicts.push(`${owner.current.length} people or teams are each recorded as ${owner.role} for ${project?.name ?? owner.project} with no evidenced handoff.`);
        for (const item of owner.current) {
          add({
            step,
            kind: "conflicting_owner",
            summary: `${item.assignee.name} is recorded as ${owner.role} for ${project?.name ?? owner.project} from ${item.from.value}, but this conflicts with another record.`,
            entities: [who(item)],
            choices: [],
            dates: [day(item.from.value) as string],
            citation_ids: cite(item.evidence, sources),
            unknown: [],
            conflict_group: group,
          });
        }
      } else {
        for (const item of owner.current) {
          add({
            step,
            kind: "owner",
            summary: `${item.assignee.name} holds ${owner.role} for ${project?.name ?? owner.project}${at ? ` as of ${at}` : ""}, since ${item.from.value}.`,
            entities: [who(item)],
            choices: [],
            dates: [day(item.from.value) as string, ...(at ? [at] : [])],
            citation_ids: cite(item.evidence, sources),
            unknown: [],
            conflict_group: null,
          });
        }
      }
      if (owner.previous) {
        const item = owner.previous;
        add({
          step,
          kind: "previous_owner",
          summary: `Before that, ${item.assignee.name} held ${owner.role} from ${item.from.value} to ${item.to?.value ?? "an unrecorded date"}.`,
          entities: [who(item)],
          choices: [],
          dates: [day(item.from.value), day(item.to?.value)].filter((d): d is string => Boolean(d)),
          citation_ids: cite(item.evidence, sources),
          unknown: [],
          conflict_group: null,
        });
      }
      if (owner.scheduled_successor) {
        const item = owner.scheduled_successor;
        add({
          step,
          kind: "scheduled_owner",
          summary: `${item.assignee.name} is scheduled to take over ${owner.role} from ${item.from.value}.`,
          entities: [who(item)],
          choices: [],
          dates: [day(item.from.value) as string],
          citation_ids: cite(item.evidence, sources),
          unknown: [],
          conflict_group: null,
        });
      }
    }

    function decisionSummary(decision: DecisionFact): { text: string; unknown: string[]; dates: string[]; entities: { id: string; name: string }[] } {
      const unknown: string[] = [];
      const parts = [`${decision.choice} is the decision on ${decision.topic}`];
      const decided = day(decision.decided_at?.value);
      const effective = day(decision.effective_at?.value);
      if (decided) parts.push(`decided ${decided}`);
      if (effective && effective !== decided) parts.push(`effective ${effective}`);
      if (decision.decided_by) parts.push(`decided by ${decision.decided_by.name}`);
      else unknown.push("decided_by");
      let text = `${parts.join(", ")}.`;
      if (decision.rationale) text += ` Recorded rationale: ${decision.rationale}`;
      else {
        unknown.push("rationale");
        text += " No rationale is recorded.";
      }
      if (!decision.decided_by) text += " Who decided it is not recorded.";
      return {
        text,
        unknown,
        dates: [decided, effective].filter((d): d is string => Boolean(d)),
        entities: decision.decided_by ? [{ id: decision.decided_by.id, name: decision.decided_by.name }] : [],
      };
    }

    function replacementFact(replacement: Replacement, kind: "replacement" | "replaced_decision" | "scheduled_replacement", step: number) {
      const effective = day(replacement.effective_at.value) as string;
      const summary =
        kind === "scheduled_replacement"
          ? `${replacement.new_decision.choice} is scheduled to replace ${replacement.old_decision.choice} for ${replacement.topic} from ${effective}.`
          : `${replacement.new_decision.choice} replaced ${replacement.old_decision.choice} for ${replacement.topic}, effective ${effective}.`;
      add({
        step,
        kind,
        summary,
        entities: [],
        choices: [replacement.new_decision.choice, replacement.old_decision.choice],
        dates: [effective, day(replacement.old_decision.decided_at?.value), day(replacement.new_decision.decided_at?.value)].filter((d): d is string => Boolean(d)),
        citation_ids: [...cite(replacement.evidence, sources), ...cite(replacement.old_decision.evidence, sources, ["decision"])],
        unknown: [],
        conflict_group: null,
      });
    }

    function explainFacts(explain: ExplainFacts, step: number) {
      if (explain.decision) {
        const summary = decisionSummary(explain.decision);
        if (summary.unknown.includes("rationale")) missing.push(`No rationale is recorded for the ${explain.decision.choice} decision.`);
        add({
          step,
          kind: "decision",
          summary: summary.text,
          entities: summary.entities,
          choices: [explain.decision.choice],
          dates: summary.dates,
          citation_ids: cite(explain.decision.evidence, sources),
          unknown: summary.unknown,
          conflict_group: null,
        });
      }
      for (const item of explain.supersedes) replacementFact(item.replacement, "replaced_decision", step);
      if (explain.scheduled_replacement) replacementFact(explain.scheduled_replacement, "scheduled_replacement", step);
      for (const proposal of explain.open_proposals) {
        add({
          step,
          kind: "proposal",
          summary: `${proposal.choice} was proposed for ${proposal.topic} on ${day(proposal.proposed_at?.value) ?? "an unrecorded date"} but not decided.`,
          entities: [],
          choices: [proposal.choice],
          dates: [day(proposal.proposed_at?.value)].filter((d): d is string => Boolean(d)),
          citation_ids: cite(proposal.evidence, sources),
          unknown: [],
          conflict_group: null,
        });
      }
      if (explain.conflicting.length) {
        const group = `decision-${step}`;
        conflicts.push(`${explain.conflicting.length} decisions on ${explain.topic} are in effect and none replaces the others.`);
        for (const decision of explain.conflicting) {
          const summary = decisionSummary(decision);
          add({ step, kind: "conflicting_decision", summary: `${summary.text} This conflicts with another recorded decision.`, entities: summary.entities, choices: [decision.choice], dates: summary.dates, citation_ids: cite(decision.evidence, sources), unknown: summary.unknown, conflict_group: group });
        }
      }
    }

    function changesFacts(changes: ChangesFacts, step: number) {
      for (const replacement of changes.replacements) replacementFact(replacement, "replacement", step);
      for (const decision of changes.newly_effective_decisions) {
        const summary = decisionSummary(decision);
        add({ step, kind: "decision_effective", summary: summary.text, entities: summary.entities, choices: [decision.choice], dates: summary.dates, citation_ids: cite(decision.evidence, sources, ["decision"]), unknown: summary.unknown, conflict_group: null });
      }
      for (const transfer of changes.ownership_transfers) {
        const from = transfer.from_assignment;
        add({
          step,
          kind: "ownership_transfer",
          summary: `${transfer.role} passed from ${from?.assignee.name ?? "an unrecorded holder"} to ${transfer.to_assignment.assignee.name} on ${day(transfer.effective_at.value)}.`,
          entities: [who(transfer.to_assignment), ...(from ? [who(from)] : [])],
          choices: [],
          dates: [day(transfer.effective_at.value) as string],
          citation_ids: cite(transfer.to_assignment.evidence, sources),
          unknown: [],
          conflict_group: null,
        });
      }
      for (const start of changes.ownership_starts) {
        add({ step, kind: "ownership_start", summary: `${start.assignee.name} started holding the role on ${day(start.from.value)}.`, entities: [who(start)], choices: [], dates: [day(start.from.value) as string], citation_ids: cite(start.evidence, sources), unknown: [], conflict_group: null });
      }
      if (!changes.replacements.length && !changes.newly_effective_decisions.length && !changes.ownership_transfers.length && !changes.ownership_starts.length) {
        add({ step, kind: "no_record", summary: "No recorded changes took effect in that period.", entities: [], choices: [], dates: [], citation_ids: [], unknown: [], conflict_group: null });
      }
    }

    function timelineFacts(timeline: TimelineFacts, step: number) {
      for (const event of timeline.events) {
        const date = day(event.at.value) as string;
        switch (event.type) {
          case "decision":
            add({ step, kind: "event", summary: `${date}: ${event.decision.choice} decided for ${event.topic}.`, entities: [], choices: [event.decision.choice], dates: [date], citation_ids: cite(event.decision.evidence, sources, ["decision"]), unknown: [], conflict_group: null });
            break;
          case "proposal":
            add({ step, kind: "event", summary: `${date}: ${event.decision.choice} proposed for ${event.topic}, not decided.`, entities: [], choices: [event.decision.choice], dates: [date], citation_ids: cite(event.decision.evidence, sources, ["proposal"]), unknown: [], conflict_group: null });
            break;
          case "replacement":
            add({ step, kind: "event", summary: `${date}: ${event.replacement.new_decision.choice} replaced ${event.replacement.old_decision.choice} for ${event.topic}.`, entities: [], choices: [event.replacement.new_decision.choice, event.replacement.old_decision.choice], dates: [date], citation_ids: cite(event.replacement.evidence, sources), unknown: [], conflict_group: null });
            break;
          case "ownership_start":
            add({ step, kind: "event", summary: `${date}: ${event.assignment.assignee.name} became ${event.role}.`, entities: [who(event.assignment)], choices: [], dates: [date], citation_ids: cite(event.assignment.evidence, sources), unknown: [], conflict_group: null });
            break;
          case "ownership_transfer": {
            const from = event.transfer.from_assignment;
            add({ step, kind: "event", summary: `${date}: ${event.role} passed from ${from?.assignee.name ?? "an unrecorded holder"} to ${event.transfer.to_assignment.assignee.name}.`, entities: [who(event.transfer.to_assignment), ...(from ? [who(from)] : [])], choices: [], dates: [date], citation_ids: cite(event.transfer.to_assignment.evidence, sources), unknown: [], conflict_group: null });
            break;
          }
          case "ownership_end":
            add({ step, kind: "event", summary: `${date}: ${event.assignment.assignee.name} stopped being ${event.role}.`, entities: [who(event.assignment)], choices: [], dates: [date], citation_ids: cite(event.assignment.evidence, sources), unknown: [], conflict_group: null });
            break;
        }
      }
    }
  });

  const packet: EvidencePacket = { question, as_of: asOfLocal, build_id: buildId, facts, citations, missing, conflicts, truncated };
  return enforceBudget(packet);
}

// Keeps the packet within the context budget by dropping optional facts (then their unused
// citations), never main facts' citations; anything dropped sets `truncated`.
function enforceBudget(packet: EvidencePacket): EvidencePacket {
  const size = (p: EvidencePacket) => estimateTokens(JSON.stringify(p));
  let current = packet;
  const optional = [...packet.facts].reverse().filter((fact) => !MAIN_FACT_KINDS.includes(fact.kind));
  for (const fact of optional) {
    if (size(current) <= PACKET_TOKEN_BUDGET) break;
    const facts = current.facts.filter((item) => item.fact_id !== fact.fact_id);
    const used = new Set(facts.flatMap((item) => item.citation_ids));
    current = { ...current, facts, citations: current.citations.filter((c) => used.has(c.citation_id)), truncated: true };
  }
  return current;
}
