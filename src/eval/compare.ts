import type {
  Assignment,
  ChangesFacts,
  DecisionFact,
  EvidenceItem,
  ExplainFacts,
  LocalTime,
  OwnerFacts,
  TimelineEvent,
  TimelineFacts,
  ToolResponse,
} from "@/contracts/graph-tools";

// Compares a tool response with an independent expected answer. Every expectation key must be
// understood; an unknown key fails the case rather than being silently ignored.

export type ExpectedCase = { id: string; question: string; request: Record<string, unknown>; expect: Record<string, unknown> };
export type CaseResult = { id: string; question: string; ok: boolean; outcome: string; failures: string[] };

const localDate = (time: LocalTime | null | undefined) => time?.value.slice(0, 10) ?? null;
const docsOf = (evidence: EvidenceItem[]) => new Set(evidence.map((item) => item.document_id));
const sameSet = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

export function compareCase(expected: ExpectedCase, response: ToolResponse): CaseResult {
  const failures: string[] = [];
  const check = (condition: boolean, message: string) => {
    if (!condition) failures.push(message);
  };
  const includesDocs = (label: string, evidence: EvidenceItem[], wanted: unknown) => {
    const have = docsOf(evidence);
    for (const doc of wanted as string[]) check(have.has(doc), `${label}: missing evidence from ${doc} (have ${[...have].join(", ") || "none"})`);
  };
  const handled = new Set<string>(["outcome"]);
  const expect = expected.expect;
  const take = (key: string) => {
    handled.add(key);
    return expect[key];
  };

  check(response.outcome === expect.outcome, `outcome: expected ${String(expect.outcome)}, got ${response.outcome}`);

  if (response.facts) {
    switch (response.intent) {
      case "owner": {
        const facts = response.facts as OwnerFacts;
        const current = facts.current;
        if ("assignees" in expect) check(sameSet(current.map((item) => item.assignee.id), take("assignees") as string[]), `assignees: got ${current.map((item) => item.assignee.id).join(", ")}`);
        if ("evidence_documents" in expect) includesDocs("current assignment", current.flatMap((item) => item.evidence), take("evidence_documents"));
        if ("previous_assignee" in expect) check(facts.previous?.assignee.id === take("previous_assignee"), `previous_assignee: got ${facts.previous?.assignee.id ?? "none"}`);
        if ("scheduled_successor" in expect) check(facts.scheduled_successor?.assignee.id === take("scheduled_successor"), `scheduled_successor: got ${facts.scheduled_successor?.assignee.id ?? "none"}`);
        break;
      }
      case "explain":
        compareExplain(response.facts as ExplainFacts, expect, take, check, includesDocs);
        break;
      case "changes": {
        const facts = response.facts as ChangesFacts;
        if ("decision_replacements" in expect) {
          const wanted = take("decision_replacements") as Record<string, unknown>[];
          check(facts.replacements.length === wanted.length, `decision_replacements: expected ${wanted.length}, got ${facts.replacements.length}`);
          for (const item of wanted) {
            const match = facts.replacements.find((r) => r.old_decision.choice === item.from_choice && r.new_decision.choice === item.to_choice);
            check(Boolean(match), `missing replacement ${String(item.from_choice)} -> ${String(item.to_choice)}`);
            if (!match) continue;
            check(localDate(match.effective_at) === item.effective_date, `replacement effective_date: got ${localDate(match.effective_at)}`);
            includesDocs("replacement", match.evidence, item.evidence_documents ?? []);
            includesDocs("replaced decision", match.old_decision.evidence, item.predecessor_evidence_documents ?? []);
          }
        }
        if ("must_not_mention_choices" in expect) {
          const mentioned = new Set([
            ...facts.replacements.flatMap((r) => [r.new_decision.choice, r.old_decision.choice]),
            ...facts.newly_effective_decisions.map((d) => d.choice),
          ]);
          for (const choice of take("must_not_mention_choices") as string[]) check(!mentioned.has(choice), `mentions ${choice}`);
        }
        break;
      }
      case "timeline":
        compareTimeline(response.facts as TimelineFacts, expect, take, check, includesDocs);
        break;
      case "resolve_alias": {
        const facts = response.facts as { candidates: { id: string }[] };
        if ("candidates" in expect) check(sameSet(facts.candidates.map((c) => c.id), take("candidates") as string[]), `candidates: got ${facts.candidates.map((c) => c.id).join(", ")}`);
        break;
      }
    }
  }

  for (const key of Object.keys(expect)) {
    if (!handled.has(key) && response.facts) failures.push(`unhandled expectation key "${key}" for intent ${response.intent}`);
  }
  return { id: expected.id, question: expected.question, ok: failures.length === 0, outcome: response.outcome, failures };
}

type Take = (key: string) => unknown;
type Check = (condition: boolean, message: string) => void;
type IncludesDocs = (label: string, evidence: EvidenceItem[], wanted: unknown) => void;

function compareExplain(facts: ExplainFacts, expect: Record<string, unknown>, take: Take, check: Check, includesDocs: IncludesDocs) {
  const decision: DecisionFact | null = facts.decision;
  const role = (r: string) => decision?.evidence.filter((item) => item.role === r) ?? [];
  if ("choice" in expect) check(decision?.choice === take("choice"), `choice: got ${decision?.choice ?? "none"}`);
  if ("status" in expect) check(facts.status === take("status"), `status: got ${facts.status}`);
  if ("decided_date" in expect) check(localDate(decision?.decided_at) === take("decided_date"), `decided_date: got ${localDate(decision?.decided_at)}`);
  if ("effective_date" in expect) check(localDate(decision?.effective_at) === take("effective_date"), `effective_date: got ${localDate(decision?.effective_at)}`);
  if ("decided_by" in expect) check((decision?.decided_by?.id ?? null) === take("decided_by"), `decided_by: got ${decision?.decided_by?.id ?? "null"}`);
  if ("decided_in_document" in expect) {
    const docs = [...docsOf(role("decision"))];
    check(docs.length === 1 && docs[0] === take("decided_in_document"), `decided_in_document: got ${docs.join(", ") || "none"}`);
  }
  if ("rationale_known" in expect) check((decision?.rationale !== null && decision?.rationale !== undefined) === take("rationale_known"), `rationale_known: got ${decision?.rationale ?? "null"}`);
  if ("rationale_evidence_documents" in expect) includesDocs("rationale", role("rationale"), take("rationale_evidence_documents"));
  if ("rationale_mentions" in expect) {
    for (const phrase of take("rationale_mentions") as string[]) {
      check(Boolean(decision?.rationale?.toLowerCase().includes(phrase.toLowerCase())), `rationale does not mention "${phrase}"`);
    }
  }
  if ("supersedes_choices" in expect) {
    const choices = facts.supersedes.map((item) => item.decision.choice);
    check(JSON.stringify(choices) === JSON.stringify(take("supersedes_choices")), `supersedes_choices: got [${choices.join(", ")}]`);
  }
  if ("pending_proposal_choices" in expect) {
    const choices = facts.open_proposals.map((item) => item.choice);
    check(sameSet(choices, take("pending_proposal_choices") as string[]), `pending_proposal_choices: got [${choices.join(", ")}]`);
  }
  if ("scheduled_replacement" in expect) {
    const wanted = take("scheduled_replacement") as Record<string, unknown>;
    const scheduled = facts.scheduled_replacement;
    check(scheduled?.new_decision.choice === wanted.choice, `scheduled_replacement: got ${scheduled?.new_decision.choice ?? "none"}`);
    check(localDate(scheduled?.effective_at) === wanted.effective_date, `scheduled_replacement date: got ${localDate(scheduled?.effective_at)}`);
    includesDocs("scheduled replacement", scheduled?.evidence ?? [], wanted.evidence_documents ?? []);
  }
}

function compareTimeline(facts: TimelineFacts, expect: Record<string, unknown>, take: Take, check: Check, includesDocs: IncludesDocs) {
  if (!("events_in_order" in expect)) return;
  const wanted = take("events_in_order") as Record<string, unknown>[];
  check(facts.events.length === wanted.length, `events: expected ${wanted.length}, got ${facts.events.length}`);
  wanted.forEach((item, index) => {
    const event = facts.events[index];
    const label = `event ${index + 1}`;
    if (!event) return;
    check(event.type === item.type, `${label} type: expected ${String(item.type)}, got ${event.type}`);
    check(localDate(event.at) === item.date, `${label} date: expected ${String(item.date)}, got ${localDate(event.at)}`);
    const summary = summarizeEvent(event);
    for (const key of ["choice", "topic", "assignee", "from_assignee", "from_choice", "to_choice", "role"]) {
      if (key in item) check(summary[key] === item[key], `${label} ${key}: expected ${String(item[key])}, got ${summary[key] ?? "none"}`);
    }
    if (item.evidence_documents) includesDocs(label, summary.evidence as unknown as EvidenceItem[], item.evidence_documents);
  });
}

function summarizeEvent(event: TimelineEvent): Record<string, string | EvidenceItem[] | undefined> {
  const assignee = (item: Assignment | null) => item?.assignee.id;
  switch (event.type) {
    case "decision":
    case "proposal":
      return { choice: event.decision.choice, topic: event.topic, evidence: event.decision.evidence };
    case "replacement":
      return {
        topic: event.topic,
        from_choice: event.replacement.old_decision.choice,
        to_choice: event.replacement.new_decision.choice,
        evidence: event.replacement.evidence,
      };
    case "ownership_transfer":
      return {
        role: event.role,
        assignee: assignee(event.transfer.to_assignment),
        from_assignee: assignee(event.transfer.from_assignment),
        evidence: event.transfer.to_assignment.evidence,
      };
    default:
      return { role: event.role, assignee: assignee(event.assignment), evidence: event.assignment.evidence };
  }
}
