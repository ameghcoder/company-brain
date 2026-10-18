import pg from "pg";
import { migrate } from "@/db/migrate";
import { closePool, getPool } from "@/db/pool";
import { databaseConfig } from "@/config/server-env";

// Integration tests run against a separate database (<dev name>_test) on the same local server,
// so they can reset freely without touching development data.
let testUrl: string | undefined;

export async function useFreshTestDatabase(): Promise<pg.Pool> {
  await closePool();
  if (!testUrl) {
    const url = new URL(process.env.DATABASE_URL_TEST ?? databaseConfig().connectionString);
    if (!process.env.DATABASE_URL_TEST) url.pathname = `${url.pathname.replace(/_test$/, "")}_test`;
    testUrl = url.toString();
  }
  const url = new URL(testUrl);
  const database = url.pathname.slice(1);
  // Guard: resetting drops every table, so only ever do it to a *_test database.
  if (!/^[a-z0-9_]+_test$/.test(database)) throw new Error(`Refusing to reset non-test database "${database}"`);

  const admin = new pg.Client({ connectionString: new URL("/postgres", url).toString() });
  await admin.connect();
  try {
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
    if (!exists.rowCount) await admin.query(`CREATE DATABASE "${database}"`);
  } finally {
    await admin.end();
  }

  process.env.DATABASE_URL = testUrl;
  const pool = getPool();
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await migrate(pool);
  return pool;
}
