import type { GraphNode, NodeKind } from "@/answer/graph-view";
import type { PathEdge } from "@/contracts/graph-tools";

// Columns by node kind, left to right: who/what the facts are about, the claims, then the source
// chunks and document versions that evidence them. No layout engine needed for a few dozen nodes.
const COLUMN: Record<NodeKind, number> = {
  project: 0,
  person: 0,
  team: 0,
  other: 0,
  replacement: 1,
  decision: 2,
  proposal: 2,
  assignment: 2,
  chunk: 3,
  version: 4,
};
export const LAYOUT = { columnWidth: 250, rowHeight: 64 } as const;

export type PlacedNode = GraphNode & { x: number; y: number };

export function layoutGraph(nodes: GraphNode[], paths: PathEdge[]): PlacedNode[] {
  const columns = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    const column = COLUMN[node.kind];
    columns.set(column, [...(columns.get(column) ?? []), node]);
  }
  // Within a column, order by first appearance in the paths so related nodes sit near each other.
  const order = new Map<string, number>();
  paths.forEach((path, index) => {
    if (!order.has(path.from)) order.set(path.from, index * 2);
    if (!order.has(path.to)) order.set(path.to, index * 2 + 1);
  });
  const tallest = Math.max(0, ...[...columns.values()].map((column) => column.length));
  return [...columns.entries()].flatMap(([column, members]) => {
    const sorted = [...members].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0) || a.id.localeCompare(b.id));
    const offset = ((tallest - sorted.length) * LAYOUT.rowHeight) / 2;
    return sorted.map((node, row) => ({ ...node, x: column * LAYOUT.columnWidth, y: offset + row * LAYOUT.rowHeight }));
  });
}
