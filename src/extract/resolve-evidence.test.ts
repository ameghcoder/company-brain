import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveEvidence } from "@/extract/resolve-evidence";

const chunks = [
  { chunkId: "doc@1/c/0", versionId: "doc@1", documentId: "doc", body: "Approved by: Dana Ortiz" },
  { chunkId: "doc@1/c/1", versionId: "doc@1", documentId: "doc", body: "Dana Ortiz said yes. Dana Ortiz said it twice." },
];

describe("evidence resolution", () => {
  it("locates a unique quote and records its span in the chunk", () => {
    const result = resolveEvidence({ document: "doc", role: "decided_by", quote: "Approved by: Dana Ortiz" }, chunks);
    assert.deepEqual(result, {
      ok: true,
      evidence: { chunk_id: "doc@1/c/0", version_id: "doc@1", document_id: "doc", role: "decided_by", quote: "Approved by: Dana Ortiz", start: 0, end: 23 },
    });
  });

  it("rejects a quote that occurs more than once", () => {
    const result = resolveEvidence({ document: "doc", role: "decided_by", quote: "Dana Ortiz" }, chunks);
    assert.deepEqual(result.ok, false);
    assert.match(!result.ok ? result.error : "", /occurs 3 times/);
  });

  it("rejects a quote absent from the selected version", () => {
    const result = resolveEvidence({ document: "doc", role: "decision", quote: "Use Stripe" }, chunks);
    assert.match(!result.ok ? result.error : "", /quote not found in doc/);
  });
});
