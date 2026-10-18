import type pg from "pg";
import { normalizeAlias, resolveFromMatches, type AliasResolution, type EntityKind, type Registry } from "@/ingest/registry";

export type RegistrySeedResult = { entitiesUpserted: number; aliases: number };

// Entities are upserted (never deleted: claims may reference them). The alias set is replaced so it
// always mirrors the CSVs exactly.
export async function writeRegistry(client: pg.PoolClient, registry: Registry): Promise<RegistrySeedResult> {
  let entitiesUpserted = 0;
  for (const entity of registry.entities) {
    const result = await client.query(
      `INSERT INTO entities (entity_id, kind, canonical_name, attributes) VALUES ($1, $2, $3, $4)
       ON CONFLICT (entity_id) DO UPDATE
         SET canonical_name = EXCLUDED.canonical_name, attributes = EXCLUDED.attributes
         WHERE entities.kind = EXCLUDED.kind
           AND (entities.canonical_name, entities.attributes) IS DISTINCT FROM (EXCLUDED.canonical_name, EXCLUDED.attributes)`,
      [entity.entityId, entity.kind, entity.canonicalName, JSON.stringify(entity.attributes)],
    );
    entitiesUpserted += result.rowCount ?? 0;
    const kind = await client.query<{ kind: string }>("SELECT kind FROM entities WHERE entity_id = $1", [entity.entityId]);
    if (kind.rows[0]?.kind !== entity.kind) {
      throw new Error(`Entity ${entity.entityId} changed kind; that needs an explicit migration`);
    }
  }
  await client.query("DELETE FROM entity_aliases");
  for (const alias of registry.aliases) {
    await client.query(
      "INSERT INTO entity_aliases (kind, alias_normalized, entity_id, alias) VALUES ($1, $2, $3, $4)",
      [alias.kind, alias.aliasNormalized, alias.entityId, alias.alias],
    );
  }
  return { entitiesUpserted, aliases: registry.aliases.length };
}

export async function resolveAlias(db: pg.Pool | pg.PoolClient, text: string, kind?: EntityKind): Promise<AliasResolution> {
  const result = await db.query<{ entity_id: string }>(
    `SELECT entity_id FROM entity_aliases WHERE alias_normalized = $1 AND ($2::text IS NULL OR kind = $2)`,
    [normalizeAlias(text), kind ?? null],
  );
  return resolveFromMatches(result.rows.map((row) => row.entity_id));
}

export type EntityRow = { entityId: string; kind: EntityKind; canonicalName: string };

export async function readEntities(db: pg.Pool | pg.PoolClient): Promise<EntityRow[]> {
  const result = await db.query<{ entity_id: string; kind: EntityKind; canonical_name: string }>(
    "SELECT entity_id, kind, canonical_name FROM entities ORDER BY entity_id",
  );
  return result.rows.map((row) => ({ entityId: row.entity_id, kind: row.kind, canonicalName: row.canonical_name }));
}
