import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;
// Arbitrary constant so concurrent bootstraps serialise instead of racing on the same migration.
const MIGRATION_LOCK_ID = 7_340_001;

export type MigrationResult = { applied: string[]; alreadyApplied: string[] };

export async function migrate(pool: pg.Pool): Promise<MigrationResult> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((name) => MIGRATION_FILE.test(name)).sort();
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const done = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((row) => row.name),
    );

    const result: MigrationResult = { applied: [], alreadyApplied: [] };
    for (const name of files) {
      if (done.has(name)) {
        result.alreadyApplied.push(name);
        continue;
      }
      const sql = await readFile(path.join(MIGRATIONS_DIR, name), "utf8");
      // Each migration and its bookkeeping row commit together, so a failure leaves no partial state.
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${name} failed: ${(error as Error).message}`);
      }
      result.applied.push(name);
    }
    return result;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}
