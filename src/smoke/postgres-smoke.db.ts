import type pg from "pg";

export type SmokeRow = { checkKey: string; payload: unknown };

export async function upsertSmokeCheck(db: pg.Pool | pg.PoolClient, row: SmokeRow): Promise<void> {
  await db.query(
    `INSERT INTO smoke_checks (check_key, payload) VALUES ($1, $2)
     ON CONFLICT (check_key) DO UPDATE SET payload = EXCLUDED.payload, checked_at = now()`,
    [row.checkKey, JSON.stringify(row.payload)],
  );
}

export async function readSmokeCheck(db: pg.Pool | pg.PoolClient, checkKey: string): Promise<SmokeRow | undefined> {
  const result = await db.query<{ check_key: string; payload: unknown }>(
    "SELECT check_key, payload FROM smoke_checks WHERE check_key = $1",
    [checkKey],
  );
  const row = result.rows[0];
  return row && { checkKey: row.check_key, payload: row.payload };
}

export async function countSmokeChecks(db: pg.Pool | pg.PoolClient, checkKey: string): Promise<number> {
  const result = await db.query<{ count: string }>("SELECT count(*) FROM smoke_checks WHERE check_key = $1", [checkKey]);
  return Number(result.rows[0]?.count ?? 0);
}
