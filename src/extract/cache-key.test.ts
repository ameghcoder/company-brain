import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractionRunId, type ExtractionConfig } from "@/extract/cache-key";

const base: ExtractionConfig = {
  schemaVersion: "extraction-v1",
  promptVersion: "extract-prompt-v1",
  model: "model-a",
  chunkerVersions: { markdown: "md-sections-v1", meeting: "meeting-turns-v1" },
  registryRevision: "r1",
};

describe("extraction cache key", () => {
  it("is stable for identical inputs regardless of key order", () => {
    const reordered = { ...base, chunkerVersions: { meeting: "meeting-turns-v1", markdown: "md-sections-v1" } };
    assert.equal(extractionRunId("w1", base), extractionRunId("w1", reordered));
  });

  it("changes when anything that affects the model output changes", () => {
    const original = extractionRunId("w1", base);
    const variants: [string, string][] = [
      ["window", extractionRunId("w2", base)],
      ["schema", extractionRunId("w1", { ...base, schemaVersion: "extraction-v2" })],
      ["prompt", extractionRunId("w1", { ...base, promptVersion: "extract-prompt-v2" })],
      ["model", extractionRunId("w1", { ...base, model: "model-b" })],
      ["chunker", extractionRunId("w1", { ...base, chunkerVersions: { ...base.chunkerVersions, markdown: "md-sections-v2" } })],
      ["registry", extractionRunId("w1", { ...base, registryRevision: "r2" })],
    ];
    for (const [label, id] of variants) assert.notEqual(id, original, `${label} change must produce a new run`);
  });
});
