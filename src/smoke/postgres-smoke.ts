import type pg from "pg";
import { migrate } from "@/db/migrate";
import type { CheckResult } from "@/smoke/check-result";
import { countSmokeChecks, readSmokeCheck, upsertSmokeCheck } from "@/smoke/postgres-smoke.db";

const PERSISTENT_KEY = "dev-check";
const ROLLBACK_KEY = "dev-check-rollback-probe";

export async function runPostgresSmoke(pool: pg.Pool): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const version = await pool.query<{ server_version: string }>("SHOW server_version");
  results.push({ name: "postgres: connect", ok: true, detail: `server ${version.rows[0]?.server_version}` });

  const migration = await migrate(pool);
  results.push({
    name: "postgres: migrations",
    ok: true,
    detail: `applied [${migration.applied.join(", ")}], already applied [${migration.alreadyApplied.join(", ")}]`,
  });

  const payload = { marker: "smoke", schemaVersion: 1 };
  await upsertSmokeCheck(pool, { checkKey: PERSISTENT_KEY, payload });
  const stored = await readSmokeCheck(pool, PERSISTENT_KEY);
  const count = await countSmokeChecks(pool, PERSISTENT_KEY);
  results.push({
    name: "postgres: write/read, no duplicates",
    ok: JSON.stringify(stored?.payload) === JSON.stringify(payload) && count === 1,
    detail: `rows for key=${count}`,
  });

  // Isolation: a row written inside an uncommitted transaction is visible there and nowhere else.
  const client = await pool.connect();
  let visibleInside = false;
  let visibleOutside = true;
  try {
    await client.query("BEGIN");
    await upsertSmokeCheck(client, { checkKey: ROLLBACK_KEY, payload: { marker: "rollback" } });
    visibleInside = (await readSmokeCheck(client, ROLLBACK_KEY)) !== undefined;
    visibleOutside = (await readSmokeCheck(pool, ROLLBACK_KEY)) !== undefined;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
  const survivedRollback = (await readSmokeCheck(pool, ROLLBACK_KEY)) !== undefined;
  results.push({
    name: "postgres: transaction isolation and rollback",
    ok: visibleInside && !visibleOutside && !survivedRollback,
    detail: `inside=${visibleInside} outside=${visibleOutside} afterRollback=${survivedRollback}`,
  });
  return results;
}
