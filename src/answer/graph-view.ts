import type { EvidencePacket } from "@/answer/evidence-packet";
import type { PathEdge, ToolResponse } from "@/contracts/graph-tools";

// Labels for the IDs in a response's paths, so the UI can draw the graph from the public response
// alone. Built from verified tool output; IDs with no recognisable source get their ID as label.

export type NodeKind = "project" | "person" | "team" | "decision" | "proposal" | "replacement" | "assignment" | "chunk" | "version" | "other";
export type GraphNode = { id: string; label: string; kind: NodeKind };

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function entityKind(id: string): NodeKind {
  if (id.startsWith("proj-")) return "project";
  if (id.startsWith("p-")) return "person";
  if (id.startsWith("t-")) return "team";
  return "other";
}

export function pathNodes(paths: PathEdge[], responses: ToolResponse[], packet: EvidencePacket | null): GraphNode[] {
  const labels = new Map<string, Omit<GraphNode, "id">>();
  const set = (id: string, label: string, kind: NodeKind) => {
    if (!labels.has(id)) labels.set(id, { label, kind });
  };

  for (const fact of packet?.facts ?? []) for (const entity of fact.entities) set(entity.id, entity.name, entityKind(entity.id));

  // Walk tool facts by shape: decisions carry a choice, assignments an assignee, replacements a
  // new decision. Inner objects are visited first so a replacement can name its decisions.
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!isObject(value)) return;
    Object.values(value).forEach(visit);
    const claimId = typeof value.claim_id === "string" ? value.claim_id : null;
    if (isObject(value.assignee) && typeof value.assignee.id === "string") {
      set(value.assignee.id, String(value.assignee.name ?? value.assignee.id), entityKind(value.assignee.id));
    }
    if (isObject(value.decided_by) && typeof value.decided_by.id === "string") {
      set(value.decided_by.id, String(value.decided_by.name ?? value.decided_by.id), entityKind(value.decided_by.id));
    }
    if (!claimId) return;
    if (typeof value.choice === "string") {
      const proposed = value.lifecycle === "proposed";
      set(claimId, `${proposed ? "Proposed" : "Decided"}: ${value.choice}`, proposed ? "proposal" : "decision");
    } else if (isObject(value.new_decision) && isObject(value.old_decision)) {
      set(claimId, `Replaced ${String(value.old_decision.choice)} with ${String(value.new_decision.choice)}`, "replacement");
    } else if (isObject(value.assignee)) {
      set(claimId, `${String(value.assignee.name)} assigned`, "assignment");
    }
  };
  for (const response of responses) {
    visit(response.facts);
    for (const source of response.sources) {
      const heading = source.heading_path.at(-1);
      set(source.chunk_id, heading && heading !== source.title ? `${source.title} › ${heading}` : source.title, "chunk");
      set(source.version_id, `${source.title} (${source.event_date})`, "version");
    }
  }

  const ids = new Set(paths.flatMap((path) => [path.from, path.to]));
  return [...ids].map((id) => ({ id, ...(labels.get(id) ?? { label: id, kind: entityKind(id) }) }));
}

// Edges that support an answer item: those touching a claim its citations name, plus the cited
// chunks' PART_OF edges. Other claims evidenced by the same chunk are not highlighted.
export function itemEdges(citationIds: string[], packet: EvidencePacket | null, paths: PathEdge[]): number[] {
  const claims = new Set<string>();
  const chunks = new Set<string>();
  for (const citation of packet?.citations ?? []) {
    if (!citationIds.includes(citation.citation_id)) continue;
    claims.add(citation.claim_id);
    chunks.add(citation.chunk_id);
  }
  return paths.flatMap((path, index) =>
    claims.has(path.from) || claims.has(path.to) || (path.rel === "PART_OF" && chunks.has(path.from)) ? [index] : [],
  );
}
