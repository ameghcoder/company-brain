import type { Graph } from "falkordb";
import type {
  Assignment,
  ChangesFacts,
  ChangesRequest,
  DecisionFact,
  ExplainFacts,
  ExplainRequest,
  Outcome,
  OwnerFacts,
  OwnerRequest,
  OwnershipTransfer,
  PathEdge,
  Replacement,
  TimelineEvent,
  TimelineFacts,
  TimelineRequest,
} from "@/contracts/graph-tools";
import {
  assignmentsFor,
  decisionsFor,
  findProject,
  replacementsFor,
  type AssignmentRow,
  type DecisionRow,
  type ReplacementRow,
} from "@/graph/queries";
import { parseInstant } from "@/time/company-time";

// Starting bounds from the architecture; results beyond them are flagged as truncated.
export const LIMITS = { supersessionHops: 8, timelineEvents: 100 } as const;

export type ToolResult<F> = { outcome: Outcome; facts: F | null; paths: PathEdge[]; notes: string[]; truncated: boolean };

function decisionFact(row: DecisionRow): DecisionFact {
  return {
    claim_id: row.claimId,
    topic: row.topic,
    choice: row.choice,
    title: row.title,
    lifecycle: row.lifecycle,
    proposed_at: row.proposedAt,
    decided_at: row.decidedAt,
    effective_at: row.effectiveAt,
    effective_basis: row.effectiveBasis,
    rationale: row.rationale,
    decided_by: row.decidedBy,
    evidence: row.evidence,
  };
}

function assignment(row: AssignmentRow): Assignment {
  return { claim_id: row.claimId, assignee: row.assignee, from: row.from, to: row.to, end_reason: row.endReason, evidence: row.evidence };
}

function evidencePaths(claimId: string, evidence: { chunk_id: string; version_id: string }[]): PathEdge[] {
  return evidence.flatMap((item) => [
    { from: claimId, rel: "EVIDENCED_BY", to: item.chunk_id },
    { from: item.chunk_id, rel: "PART_OF", to: item.version_id },
  ]);
}

function decisionPaths(projectId: string, decision: DecisionFact): PathEdge[] {
  return [
    { from: decision.claim_id, rel: "AFFECTS", to: projectId },
    ...(decision.decided_by ? [{ from: decision.claim_id, rel: "DECIDED_BY", to: decision.decided_by.id }] : []),
    ...evidencePaths(decision.claim_id, decision.evidence),
  ];
}

function assignmentPaths(projectId: string, item: Assignment): PathEdge[] {
  return [
    { from: item.claim_id, rel: "FOR_PROJECT", to: projectId },
    { from: item.claim_id, rel: "ASSIGNS_TO", to: item.assignee.id },
    ...evidencePaths(item.claim_id, item.evidence),
  ];
}

function replacementPaths(projectId: string, replacement: Replacement): PathEdge[] {
  return [
    { from: replacement.claim_id, rel: "NEW_DECISION", to: replacement.new_decision.claim_id },
    { from: replacement.claim_id, rel: "OLD_DECISION", to: replacement.old_decision.claim_id },
    { from: replacement.new_decision.claim_id, rel: "SUPERSEDES", to: replacement.old_decision.claim_id },
    ...evidencePaths(replacement.claim_id, replacement.evidence),
    ...decisionPaths(projectId, replacement.new_decision),
    ...decisionPaths(projectId, replacement.old_decision),
  ];
}

function toReplacement(row: ReplacementRow, decisions: Map<string, DecisionFact>): Replacement {
  const newDecision = decisions.get(row.newDecisionId);
  const oldDecision = decisions.get(row.oldDecisionId);
  if (!newDecision || !oldDecision) throw new Error(`Replacement ${row.claimId} references a decision outside its topic set`);
  return { claim_id: row.claimId, topic: row.topic, effective_at: row.effectiveAt, new_decision: newDecision, old_decision: oldDecision, evidence: row.evidence };
}

async function unknownProject<F>(graph: Graph, projectId: string): Promise<ToolResult<F> | undefined> {
  if (await findProject(graph, projectId)) return undefined;
  return { outcome: "insufficient_evidence", facts: null, paths: [], notes: [`No project ${projectId} in this build.`], truncated: false };
}

export async function getOwner(graph: Graph, request: OwnerRequest): Promise<ToolResult<OwnerFacts>> {
  const missing = await unknownProject<OwnerFacts>(graph, request.project);
  if (missing) return missing;
  const atMs = parseInstant(request.at).getTime();
  const rows = await assignmentsFor(graph, request.project, request.role, atMs);
  if (!rows.length) {
    return { outcome: "insufficient_evidence", facts: null, paths: [], notes: [`No recorded assignments for ${request.role}.`], truncated: false };
  }

  const current = rows.filter((row) => row.activeAt);
  const exclusive = rows.some((row) => row.exclusive);
  const only = current.length === 1 ? current[0] : undefined;
  // The predecessor is the assignment this one took over from; otherwise the latest that ended by `at`.
  const previous =
    (only && rows.find((row) => row.endedBy === only.claimId)) ??
    rows.filter((row) => row.to !== null && row.to.ms <= atMs).sort((a, b) => (b.to?.ms ?? 0) - (a.to?.ms ?? 0))[0];
  const successor = only ? rows.find((row) => row.handoffFrom === only.claimId && row.from.ms > atMs) : undefined;

  const facts: OwnerFacts = {
    project: request.project,
    role: request.role,
    at: request.at,
    exclusive,
    current: current.map(assignment),
    previous: previous ? assignment(previous) : null,
    scheduled_successor: successor ? assignment(successor) : null,
  };
  const notes: string[] = [];
  let outcome: Outcome = "answered";
  if (!current.length) {
    outcome = "insufficient_evidence";
    notes.push(`No recorded assignment for ${request.role} is in effect at ${request.at}; ownership then is unknown.`);
  } else if (current.length > 1 && exclusive) {
    outcome = "conflicting_evidence";
    notes.push(`${current.length} assignments for the exclusive role ${request.role} overlap at ${request.at} with no evidenced handoff.`);
  }
  const shown = [...facts.current, ...(facts.previous ? [facts.previous] : []), ...(facts.scheduled_successor ? [facts.scheduled_successor] : [])];
  return { outcome, facts, paths: shown.flatMap((item) => assignmentPaths(request.project, item)), notes, truncated: false };
}

export async function explainDecision(graph: Graph, request: ExplainRequest): Promise<ToolResult<ExplainFacts>> {
  const missing = await unknownProject<ExplainFacts>(graph, request.project);
  if (missing) return missing;
  const atMs = parseInstant(request.at).getTime();
  const rows = await decisionsFor(graph, request.project, request.topic, atMs);
  if (!rows.length) {
    return { outcome: "insufficient_evidence", facts: null, paths: [], notes: [`No recorded decisions or proposals about ${request.topic}.`], truncated: false };
  }
  const decisions = new Map(rows.map((row) => [row.claimId, decisionFact(row)]));
  const replacements = (await replacementsFor(graph, request.project, request.topic)).map((row) => toReplacement(row, decisions));
  const current = rows.filter((row) => row.currentAt).map((row) => decisions.get(row.claimId) as DecisionFact);
  const decided = rows.filter((row) => row.lifecycle === "decided" && row.decidedAt);

  // A proposal stays open until some decision on the topic is made after it.
  const openProposals = rows
    .filter((row) => row.lifecycle === "proposed" && row.proposedAt && row.proposedAt.ms <= atMs)
    .filter((proposal) => !decided.some((row) => (row.decidedAt?.ms ?? 0) > (proposal.proposedAt?.ms ?? 0) && (row.decidedAt?.ms ?? 0) <= atMs))
    .map((row) => decisions.get(row.claimId) as DecisionFact);

  const facts: ExplainFacts = {
    project: request.project,
    topic: request.topic,
    at: request.at,
    status: current.length === 1 ? "current" : current.length > 1 ? "conflict" : "none_current",
    decision: current.length === 1 ? (current[0] ?? null) : null,
    supersedes: [],
    scheduled_replacement: null,
    open_proposals: openProposals,
    conflicting: current.length > 1 ? current : [],
  };
  const notes: string[] = [];
  let truncated = false;
  let outcome: Outcome = "answered";

  if (facts.decision) {
    // Walk back through replacements already in effect at `at`, newest first.
    let frontier = [facts.decision.claim_id];
    const seen = new Set(frontier);
    for (let hop = 0; frontier.length; hop++) {
      if (hop === LIMITS.supersessionHops) {
        truncated = true;
        notes.push(`Replacement history truncated after ${LIMITS.supersessionHops} steps.`);
        break;
      }
      const next: string[] = [];
      for (const id of frontier) {
        for (const replacement of replacements.filter((item) => item.new_decision.claim_id === id && item.effective_at.ms <= atMs)) {
          if (seen.has(replacement.old_decision.claim_id)) continue;
          seen.add(replacement.old_decision.claim_id);
          facts.supersedes.push({ decision: replacement.old_decision, replacement });
          next.push(replacement.old_decision.claim_id);
        }
      }
      frontier = next;
    }
    const decisionId = facts.decision.claim_id;
    facts.scheduled_replacement =
      replacements.filter((item) => item.old_decision.claim_id === decisionId && item.effective_at.ms > atMs).sort((a, b) => a.effective_at.ms - b.effective_at.ms)[0] ?? null;
    if (facts.decision.rationale === null) notes.push("The sources record no rationale for this decision.");
    if (facts.decision.decided_by === null) notes.push("The sources do not say who made this decision.");
  } else if (current.length > 1) {
    outcome = "conflicting_evidence";
    notes.push(`${current.length} decisions on ${request.topic} are in effect at ${request.at} and none replaces the others.`);
  } else {
    outcome = "insufficient_evidence";
    notes.push(`No decision on ${request.topic} is in effect at ${request.at}.`);
  }

  const shownDecisions = [...(facts.decision ? [facts.decision] : []), ...facts.conflicting, ...facts.open_proposals];
  const shownReplacements = [...facts.supersedes.map((item) => item.replacement), ...(facts.scheduled_replacement ? [facts.scheduled_replacement] : [])];
  const paths = [
    ...shownDecisions.flatMap((decision) => decisionPaths(request.project, decision)),
    ...shownReplacements.flatMap((replacement) => replacementPaths(request.project, replacement)),
  ];
  return { outcome, facts, paths, notes, truncated };
}

async function changeRecords(graph: Graph, projectId: string, topic: string | null) {
  const decisionRows = await decisionsFor(graph, projectId, topic, 0);
  const decisions = new Map(decisionRows.map((row) => [row.claimId, decisionFact(row)]));
  const replacements = (await replacementsFor(graph, projectId, topic)).map((row) => toReplacement(row, decisions));
  const assignmentRows = await assignmentsFor(graph, projectId, topic, 0);
  const assignments = new Map(assignmentRows.map((row) => [row.claimId, assignment(row)]));
  const transfers: OwnershipTransfer[] = assignmentRows
    .filter((row) => row.handoffFrom)
    .map((row) => ({
      claim_id: row.claimId,
      role: row.role,
      effective_at: row.from,
      from_assignment: (row.handoffFrom && assignments.get(row.handoffFrom)) || null,
      to_assignment: assignments.get(row.claimId) as Assignment,
    }));
  const starts = assignmentRows.filter((row) => !row.handoffFrom);
  return { decisionRows, decisions, replacements, assignmentRows, transfers, starts };
}

export async function getChanges(graph: Graph, request: ChangesRequest): Promise<ToolResult<ChangesFacts>> {
  const missing = await unknownProject<ChangesFacts>(graph, request.project);
  if (missing) return missing;
  const fromMs = parseInstant(request.from).getTime();
  const toMs = parseInstant(request.to).getTime();
  const inWindow = (ms: number) => fromMs <= ms && ms < toMs;
  const records = await changeRecords(graph, request.project, request.topic ?? null);

  if (request.topic && !records.decisionRows.length && !records.assignmentRows.length) {
    return { outcome: "insufficient_evidence", facts: null, paths: [], notes: [`No recorded decisions or assignments about ${request.topic}.`], truncated: false };
  }
  const replacements = records.replacements.filter((item) => inWindow(item.effective_at.ms));
  const replacing = new Set(records.replacements.map((item) => item.new_decision.claim_id));
  const facts: ChangesFacts = {
    project: request.project,
    topic: request.topic ?? null,
    from: request.from,
    to: request.to,
    replacements,
    // Decisions that took effect in the window without replacing anything.
    newly_effective_decisions: records.decisionRows
      .filter((row) => row.lifecycle === "decided" && row.effectiveAt && inWindow(row.effectiveAt.ms) && !replacing.has(row.claimId))
      .map((row) => records.decisions.get(row.claimId) as DecisionFact),
    ownership_transfers: records.transfers.filter((item) => inWindow(item.effective_at.ms)),
    ownership_starts: records.starts.filter((row) => inWindow(row.from.ms)).map(assignment),
  };
  const notes =
    facts.replacements.length + facts.newly_effective_decisions.length + facts.ownership_transfers.length + facts.ownership_starts.length === 0
      ? ["No recorded changes took effect in this window."]
      : [];
  const paths = [
    ...facts.replacements.flatMap((item) => replacementPaths(request.project, item)),
    ...facts.newly_effective_decisions.flatMap((item) => decisionPaths(request.project, item)),
    ...facts.ownership_transfers.flatMap((item) => [
      ...assignmentPaths(request.project, item.to_assignment),
      ...(item.from_assignment ? assignmentPaths(request.project, item.from_assignment) : []),
    ]),
    ...facts.ownership_starts.flatMap((item) => assignmentPaths(request.project, item)),
  ];
  return { outcome: "answered", facts, paths, notes, truncated: false };
}

const EVENT_ORDER: TimelineEvent["type"][] = ["decision", "proposal", "replacement", "ownership_start", "ownership_transfer", "ownership_end"];

export async function getTimeline(graph: Graph, request: TimelineRequest): Promise<ToolResult<TimelineFacts>> {
  const missing = await unknownProject<TimelineFacts>(graph, request.project);
  if (missing) return missing;
  const fromMs = request.from ? parseInstant(request.from).getTime() : -Infinity;
  const toMs = request.to ? parseInstant(request.to).getTime() : Infinity;
  const records = await changeRecords(graph, request.project, request.topic ?? null);

  const events: TimelineEvent[] = [];
  for (const row of records.decisionRows) {
    const decision = records.decisions.get(row.claimId) as DecisionFact;
    if (row.lifecycle === "decided" && row.decidedAt) events.push({ type: "decision", at: row.decidedAt, topic: row.topic, decision });
    if (row.lifecycle === "proposed" && row.proposedAt) events.push({ type: "proposal", at: row.proposedAt, topic: row.topic, decision });
  }
  for (const replacement of records.replacements) events.push({ type: "replacement", at: replacement.effective_at, topic: replacement.topic, replacement });
  for (const row of records.starts) events.push({ type: "ownership_start", at: row.from, role: row.role, assignment: assignment(row) });
  for (const transfer of records.transfers) events.push({ type: "ownership_transfer", at: transfer.effective_at, role: transfer.role, transfer });
  for (const row of records.assignmentRows) {
    // Handoff ends are already shown as transfers; only stated ends are separate events.
    if (row.endReason === "stated" && row.to) events.push({ type: "ownership_end", at: row.to, role: row.role, assignment: assignment(row) });
  }

  const sorted = events
    .filter((event) => fromMs <= event.at.ms && event.at.ms < toMs)
    .sort((a, b) => a.at.ms - b.at.ms || EVENT_ORDER.indexOf(a.type) - EVENT_ORDER.indexOf(b.type));
  const truncated = sorted.length > LIMITS.timelineEvents;
  const shown = sorted.slice(0, LIMITS.timelineEvents);
  const paths = shown.flatMap((event): PathEdge[] => {
    switch (event.type) {
      case "decision":
      case "proposal":
        return decisionPaths(request.project, event.decision);
      case "replacement":
        return [
          { from: event.replacement.claim_id, rel: "NEW_DECISION", to: event.replacement.new_decision.claim_id },
          { from: event.replacement.claim_id, rel: "OLD_DECISION", to: event.replacement.old_decision.claim_id },
          { from: event.replacement.new_decision.claim_id, rel: "SUPERSEDES", to: event.replacement.old_decision.claim_id },
          ...evidencePaths(event.replacement.claim_id, event.replacement.evidence),
        ];
      case "ownership_transfer":
        return assignmentPaths(request.project, event.transfer.to_assignment);
      default:
        return assignmentPaths(request.project, event.assignment);
    }
  });
  return {
    outcome: shown.length ? "answered" : "insufficient_evidence",
    facts: { project: request.project, topic: request.topic ?? null, events: shown },
    paths,
    notes: [...(shown.length ? [] : ["No recorded events in this scope."]), ...(truncated ? [`Timeline truncated to ${LIMITS.timelineEvents} events.`] : [])],
    truncated,
  };
}
