import { readFile } from "node:fs/promises";
import { z } from "zod";
import { parseCsv } from "@/ingest/csv";
import { resolveInside, type Manifest } from "@/ingest/manifest";

export type EntityKind = "person" | "team" | "project";
export type Entity = { entityId: string; kind: EntityKind; canonicalName: string; attributes: Record<string, string> };
export type Alias = { kind: EntityKind; alias: string; aliasNormalized: string; entityId: string };

// Exact matching only (no fuzzy merging): case, Unicode form, and spacing are the only things
// normalized away.
export function normalizeAlias(text: string): string {
  return text.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

const ENTITY_ID = /^(p|t|proj)-[a-z0-9-]+$/;

export type Registry = { entities: Entity[]; aliases: Alias[] };

export async function readRegistry(manifest: Manifest): Promise<Registry> {
  const roster = parseCsv(await readFile(resolveInside(manifest.root, manifest.registry.roster), "utf8"));
  const projects = parseCsv(await readFile(resolveInside(manifest.root, manifest.registry.projects), "utf8"));

  const entities: Entity[] = [];
  const aliasesByEntity = new Map<string, string[]>();
  for (const { values } of roster) {
    const kind = values.kind;
    if (kind !== "person" && kind !== "team") throw new Error(`Roster entity ${values.entity_id}: unknown kind ${kind}`);
    entities.push({
      entityId: values.entity_id ?? "",
      kind,
      canonicalName: values.name ?? "",
      attributes: values.team_id ? { team_id: values.team_id } : {},
    });
    aliasesByEntity.set(values.entity_id ?? "", splitAliases(values.aliases));
  }
  for (const { values } of projects) {
    entities.push({
      entityId: values.project_id ?? "",
      kind: "project",
      canonicalName: values.name ?? "",
      attributes: { owning_team_id: values.owning_team_id ?? "", description: values.description ?? "" },
    });
    aliasesByEntity.set(values.project_id ?? "", splitAliases(values.aliases));
  }

  const ids = new Set<string>();
  for (const entity of entities) {
    if (!ENTITY_ID.test(entity.entityId)) throw new Error(`Invalid entity id "${entity.entityId}"`);
    if (!entity.canonicalName) throw new Error(`Entity ${entity.entityId} has no name`);
    if (ids.has(entity.entityId)) throw new Error(`Duplicate entity id ${entity.entityId}`);
    ids.add(entity.entityId);
  }
  for (const entity of entities) {
    for (const ref of [entity.attributes.team_id, entity.attributes.owning_team_id]) {
      if (ref && !ids.has(ref)) throw new Error(`Entity ${entity.entityId} references unknown team ${ref}`);
    }
  }

  const aliases: Alias[] = [];
  for (const entity of entities) {
    const names = [entity.canonicalName, ...(aliasesByEntity.get(entity.entityId) ?? [])];
    const seen = new Set<string>();
    for (const alias of names) {
      const aliasNormalized = normalizeAlias(alias);
      if (seen.has(aliasNormalized)) continue;
      seen.add(aliasNormalized);
      aliases.push({ kind: entity.kind, alias, aliasNormalized, entityId: entity.entityId });
    }
  }
  return { entities, aliases };
}

function splitAliases(field: string | undefined): string[] {
  return (field ?? "")
    .split(";")
    .map((alias) => alias.trim())
    .filter(Boolean);
}

export type AliasResolution =
  | { status: "resolved"; entityId: string }
  | { status: "ambiguous"; candidates: string[] }
  | { status: "unknown" };

export function resolveFromMatches(entityIds: string[]): AliasResolution {
  const unique = [...new Set(entityIds)].sort();
  if (unique.length === 0) return { status: "unknown" };
  if (unique.length === 1) return { status: "resolved", entityId: unique[0] as string };
  return { status: "ambiguous", candidates: unique };
}

const roleSchema = z.object({ label: z.string(), exclusive: z.boolean() });
const topicRegistrySchema = z.object({
  revision: z.number().int().positive(),
  projects: z.record(
    z.string(),
    z.object({
      decision_topics: z.record(z.string(), z.string()),
      ownership_roles: z.record(z.string(), roleSchema),
    }),
  ),
});
export type TopicRegistry = z.infer<typeof topicRegistrySchema>;

const TOPIC_KEY = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;

export async function readTopicRegistry(manifest: Manifest): Promise<TopicRegistry> {
  const raw = JSON.parse(await readFile(resolveInside(manifest.root, manifest.registry.topics), "utf8")) as unknown;
  const registry = topicRegistrySchema.parse(raw);
  for (const [project, topics] of Object.entries(registry.projects)) {
    const keys = [...Object.keys(topics.decision_topics), ...Object.keys(topics.ownership_roles)];
    for (const key of keys) {
      if (!TOPIC_KEY.test(key)) throw new Error(`Invalid topic key "${key}" in ${project}`);
    }
    const overlap = Object.keys(topics.decision_topics).find((key) => key in topics.ownership_roles);
    if (overlap) throw new Error(`Topic "${overlap}" in ${project} is both a decision topic and a role`);
  }
  return registry;
}
