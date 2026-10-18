import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractionJsonSchema, extractionOutputSchema } from "@/contracts/extraction";

type Schema = Record<string, unknown>;

// Strict structured outputs require every object to close additional properties and to list all
// of its properties as required. Walk the generated schema and check both rules everywhere.
function strictViolations(node: unknown, path = "$"): string[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap((item, index) => strictViolations(item, `${path}[${index}]`));
  const schema = node as Schema;
  const problems: string[] = [];
  if (schema.type === "object") {
    const properties = Object.keys((schema.properties as Schema | undefined) ?? {});
    if (schema.additionalProperties !== false) problems.push(`${path}: additionalProperties is not false`);
    const required = new Set((schema.required as string[] | undefined) ?? []);
    for (const property of properties) if (!required.has(property)) problems.push(`${path}.${property}: not required`);
  }
  for (const [key, value] of Object.entries(schema)) problems.push(...strictViolations(value, `${path}.${key}`));
  return problems;
}

describe("extraction contract", () => {
  it("generates a JSON schema that satisfies strict structured-output rules", () => {
    assert.deepEqual(strictViolations(extractionJsonSchema()), []);
  });

  it("rejects extra fields and missing nullable fields", () => {
    assert.equal(extractionOutputSchema.safeParse({ decisions: [], ownership: [], unresolved_mentions: [], extra: 1 }).success, false);
    assert.equal(extractionOutputSchema.safeParse({ decisions: [], ownership: [] }).success, false);
    assert.equal(extractionOutputSchema.safeParse({ decisions: [], ownership: [], unresolved_mentions: [] }).success, true);
  });
});
