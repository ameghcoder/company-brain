"use client";

import { Background, Controls, ReactFlow, type Edge, type Node } from "@xyflow/react";
import { useMemo } from "react";
import type { PublicAnswer } from "@/answer/public-response";
import { layoutGraph } from "@/components/graph-layout";

const KIND_LABEL: Record<string, string> = {
  project: "Project",
  person: "Person",
  team: "Team",
  decision: "Decision",
  proposal: "Proposal",
  replacement: "Replacement",
  assignment: "Ownership",
  chunk: "Source passage",
  version: "Document version",
  other: "Record",
};

// Only the edges the answer's tools returned; the selected item's edges are highlighted.
export function PathGraph({ answer, highlighted }: { answer: PublicAnswer; highlighted: Set<number> | null }) {
  const { nodes, edges } = useMemo(() => {
    const active = new Set<string>();
    answer.paths.forEach((path, index) => {
      if (highlighted?.has(index)) active.add(path.from).add(path.to);
    });
    const nodes: Node[] = layoutGraph(answer.nodes, answer.paths).map((node) => ({
      id: node.id,
      position: { x: node.x, y: node.y },
      data: {
        label: (
          <div className="text-left">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{KIND_LABEL[node.kind]}</div>
            <div className="line-clamp-2 text-xs leading-tight">{node.label}</div>
          </div>
        ),
      },
      draggable: false,
      connectable: false,
      sourcePosition: "right",
      targetPosition: "left",
      className: "!w-52 !rounded-md !border !bg-card !px-2 !py-1 !text-card-foreground transition-opacity",
      style: {
        opacity: highlighted && !active.has(node.id) ? 0.3 : 1,
        borderColor: active.has(node.id) ? "var(--highlight)" : "var(--border)",
        borderWidth: active.has(node.id) ? 2 : 1,
      },
    })) as Node[];
    const edges: Edge[] = answer.paths.map((path, index) => {
      const on = highlighted?.has(index) ?? false;
      return {
        id: `e${index}`,
        source: path.from,
        target: path.to,
        label: path.rel,
        labelStyle: { fontSize: 9 },
        style: { stroke: on ? "var(--highlight)" : "var(--muted-foreground)", strokeWidth: on ? 2.5 : 1, opacity: highlighted && !on ? 0.2 : 0.8 },
        zIndex: on ? 1 : 0,
      };
    });
    return { nodes, edges };
  }, [answer, highlighted]);

  if (!answer.paths.length) return <p className="text-sm text-muted-foreground">No graph paths for this answer.</p>;
  return (
    <div className="h-[36rem] w-full rounded-md border" data-testid="path-graph">
      {/* Remount per answer: fitView only runs when the flow first mounts. */}
      <ReactFlow
        key={`${answer.qa_log_id ?? ""}|${answer.question}|${answer.as_of}`}
        nodes={nodes}
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.05 }}
        minZoom={0.2}
        nodesConnectable={false}
        elementsSelectable={false}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
