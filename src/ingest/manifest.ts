import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const DOCUMENT_ID = /^[a-z0-9][a-z0-9-]{1,80}$/;

const sourceSchema = z.object({
  document_id: z.string().regex(DOCUMENT_ID),
  path: z.string().min(1),
  source_type: z.enum(["csv", "markdown", "meeting"]),
  document_type: z.enum(["roster", "projects", "assignments", "document", "meeting"]),
  title: z.string().min(1),
  author_id: z.string().optional(),
  event_at: z.string(),
  projects: z.array(z.string()),
  participants: z.array(z.string()).optional(),
});
export type SourceEntry = z.infer<typeof sourceSchema>;

const manifestSchema = z.object({
  company: z.object({ id: z.string().regex(DOCUMENT_ID), name: z.string(), timezone: z.string() }),
  registry: z.object({ roster: z.string(), projects: z.string(), topics: z.string() }),
  sources: z.array(sourceSchema).min(1),
});
export type Manifest = z.infer<typeof manifestSchema> & { root: string };

export async function loadManifest(root: string): Promise<Manifest> {
  const raw = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as unknown;
  const manifest = manifestSchema.parse(raw);
  const ids = manifest.sources.map((source) => source.document_id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) throw new Error(`Duplicate document_id in manifest: ${duplicate}`);
  for (const source of manifest.sources) resolveInside(root, source.path);
  return { ...manifest, root };
}

// Manifest paths are data; refuse anything that escapes the fixture root.
export function resolveInside(root: string, relative: string): string {
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error(`Path escapes fixture root: ${relative}`);
  return resolved;
}
