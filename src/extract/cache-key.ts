import { createHash } from "node:crypto";

export type ExtractionConfig = {
  schemaVersion: string;
  promptVersion: string;
  model: string;
  chunkerVersions: Record<string, string>;
  registryRevision: string;
};

const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Everything that can change what a model returns for a window is part of the key, so a changed
// prompt, schema, model, chunker, or registry always means a new run, never a stale cache hit.
export function extractionRunId(windowHash: string, config: ExtractionConfig): string {
  const sortedChunkers = Object.fromEntries(Object.entries(config.chunkerVersions).sort(([a], [b]) => a.localeCompare(b)));
  return `xr${sha256({ windowHash, ...config, chunkerVersions: sortedChunkers }).slice(0, 20)}`;
}

export function registryRevision(input: { entities: unknown[]; topics: unknown }): string {
  return sha256(input).slice(0, 16);
}
