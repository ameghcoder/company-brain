import pg from "pg";
import { databaseConfig } from "@/config/server-env";

let pool: pg.Pool | undefined;

// One lazily created pool per process; scripts must call closePool() so they can exit.
export function getPool(): pg.Pool {
  pool ??= new pg.Pool({
    connectionString: databaseConfig().connectionString,
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
  });
  return pool;
}

export async function closePool(): Promise<void> {
  const current = pool;
  pool = undefined;
  await current?.end();
}
