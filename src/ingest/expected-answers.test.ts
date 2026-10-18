import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_FIXTURE_ROOT } from "@/ingest/load";
import { loadManifest } from "@/ingest/manifest";
import { readRegistry } from "@/ingest/registry";
import { parseInstant } from "@/time/company-time";

// The expected answers must stay independent of the claim fixtures: they may only name
// documents, entities, and choices that a reader can check against the sources.
describe("independent expected answers", () => {
  it("reference known documents and entities and never claim IDs", async () => {
    const manifest = await loadManifest(DEFAULT_FIXTURE_ROOT);
    const registry = await readRegistry(manifest);
    const documents = new Set(manifest.sources.map((source) => source.document_id));
    const entities = new Set(registry.entities.map((entity) => entity.entityId));
    const text = await readFile(path.join(DEFAULT_FIXTURE_ROOT, "expected/answers.json"), "utf8");
    const answers = JSON.parse(text) as { cases: { id: string; request: Record<string, string>; expect: unknown }[] };

    assert.doesNotMatch(text, /"(dec|own|sup|prop|rej)-[a-z0-9-]+"/, "expected answers must not cite claim IDs");
    assert.ok(answers.cases.length >= 15);

    const visit = (value: unknown, key?: string): void => {
      if (Array.isArray(value)) return value.forEach((item) => visit(item, key));
      if (value && typeof value === "object") return Object.entries(value).forEach(([k, v]) => visit(v, k));
      if (typeof value !== "string") return;
      if (key?.endsWith("documents") || key === "decided_in_document") assert.ok(documents.has(value), `unknown document ${value}`);
      if (/^(p|t|proj)-/.test(value)) assert.ok(entities.has(value), `unknown entity ${value}`);
    };
    for (const answer of answers.cases) {
      visit(answer.expect);
      visit(answer.request);
      for (const field of ["at", "from", "to"]) {
        const value = answer.request[field];
        if (value) parseInstant(value);
      }
    }
  });
});
