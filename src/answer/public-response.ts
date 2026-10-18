import { itemEdges, pathNodes, type GraphNode } from "@/answer/graph-view";
import type { Outcome, PathEdge, ToolResponse } from "@/contracts/graph-tools";
import type { QuestionResult } from "@/retrieve/ask";

// What the question API returns. Built only from verified results: no prompts, raw plans, model
// output that failed checks, or internal debug data.
export type PublicAnswer = {
  question: string;
  as_of: string;
  build_id: string | null;
  outcome: Outcome;
  clarification: { question: string; candidates: { id: string; name: string; kind: string }[] } | null;
  // edge_ids index into paths: the edges supporting that item.
  answer: { source: "model" | "repaired" | "deterministic"; items: { text: string; citation_ids: string[]; edge_ids: number[] }[] } | null;
  citations: { citation_id: string; document_id: string; title: string; role: string; excerpt: string }[];
  timeline: { date: string; text: string; citation_ids: string[]; edge_ids: number[] }[];
  paths: PathEdge[];
  nodes: GraphNode[];
  // Project and topic of the first resolved step; sent back with a follow-up question.
  context: { project: string; topic: string | null } | null;
  incomplete: { truncated: boolean; missing: string[]; conflicts: string[] };
  notes: string[];
  qa_log_id: number | null;
};

export function toPublicResponse(result: QuestionResult): PublicAnswer {
  const packet = result.packet;
  const items = result.answer?.answer.items ?? [];
  const cited = new Set(items.flatMap((item) => item.citation_ids));
  const timeline = (packet?.facts ?? [])
    .filter((fact) => fact.kind === "event")
    .map((fact) => ({ date: fact.dates[0] ?? "", text: fact.summary, citation_ids: fact.citation_ids }));
  const responses = result.steps.flatMap((step) => (step.response ? [step.response] : [])) as ToolResponse[];
  const seen = new Set<string>();
  const paths = responses
    .flatMap((response) => response.paths)
    .filter((path) => {
      const key = `${path.from}|${path.rel}|${path.to}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const stepNotes = result.steps.flatMap((step) => step.notes);
  const resolved = result.steps.find((step) => step.request && "project" in step.request && step.request.project)?.request;
  const context =
    resolved && "project" in resolved && resolved.project
      ? { project: resolved.project, topic: ("topic" in resolved ? resolved.topic : "role" in resolved ? resolved.role : undefined) ?? null }
      : null;
  return {
    question: result.question,
    as_of: result.as_of,
    build_id: result.build_id,
    outcome: result.outcome,
    clarification: result.clarification,
    answer: result.answer
      ? { source: result.answer.source, items: items.map((item) => ({ text: item.text, citation_ids: item.citation_ids, edge_ids: itemEdges(item.citation_ids, packet, paths) })) }
      : null,
    citations: (packet?.citations ?? [])
      .filter((citation) => cited.has(citation.citation_id) || timeline.some((event) => event.citation_ids.includes(citation.citation_id)))
      .map(({ citation_id, document_id, title, role, excerpt }) => ({ citation_id, document_id, title, role, excerpt })),
    timeline: timeline.map((event) => ({ ...event, edge_ids: itemEdges(event.citation_ids, packet, paths) })),
    paths,
    nodes: pathNodes(paths, responses, packet),
    context,
    incomplete: { truncated: (packet?.truncated ?? false) || result.truncated, missing: packet?.missing ?? [], conflicts: packet?.conflicts ?? [] },
    notes: [...result.notes, ...stepNotes],
    qa_log_id: result.qa_log_id,
  };
}
