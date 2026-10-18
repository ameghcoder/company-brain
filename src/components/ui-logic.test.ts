import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LAYOUT, layoutGraph } from "@/components/graph-layout";
import { withName } from "@/components/question-helpers";

describe("graph layout", () => {
  it("places nodes in columns by kind without overlaps", () => {
    const placed = layoutGraph(
      [
        { id: "dec-a", label: "Decided: A", kind: "decision" },
        { id: "proj-x", label: "X", kind: "project" },
        { id: "chunk-1", label: "Doc", kind: "chunk" },
        { id: "dec-b", label: "Decided: B", kind: "decision" },
      ],
      [
        { from: "dec-a", rel: "AFFECTS", to: "proj-x" },
        { from: "dec-a", rel: "EVIDENCED_BY", to: "chunk-1" },
        { from: "dec-b", rel: "AFFECTS", to: "proj-x" },
      ],
    );
    const at = new Map(placed.map((node) => [node.id, node]));
    assert.equal(at.get("proj-x")?.x, 0);
    assert.equal(at.get("dec-a")?.x, 2 * LAYOUT.columnWidth);
    assert.equal(at.get("chunk-1")?.x, 3 * LAYOUT.columnWidth);
    assert.ok((at.get("dec-a")?.y ?? 0) < (at.get("dec-b")?.y ?? 0), "path order is kept within a column");
    assert.equal(new Set(placed.map((node) => `${node.x},${node.y}`)).size, placed.length);
  });
});

describe("clarified names", () => {
  it("replaces the ambiguous word with the chosen name", () => {
    assert.equal(withName("What did Alex decide?", "Alex Chen"), "What did Alex Chen decide?");
    assert.equal(withName("What did Alex Chen decide?", "Alex Chen"), "What did Alex Chen decide?");
    assert.equal(withName("Who decided it?", "Alex Rivera"), "Who decided it? (Alex Rivera)");
  });
});
