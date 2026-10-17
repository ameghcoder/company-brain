import { closePool, getPool } from "@/db/pool";
import { connectFalkorDB } from "@/graph/client";
import { printResults, type CheckResult } from "@/smoke/check-result";
import { runGraphSmoke } from "@/smoke/graph-smoke";
import { runPostgresSmoke } from "@/smoke/postgres-smoke";

// Real-service smoke checks: they talk to the running Compose services and never mock them.
async function main(): Promise<boolean> {
  const results: CheckResult[] = [];

  try {
    results.push(...(await runPostgresSmoke(getPool())));
  } catch (error) {
    results.push({ name: "postgres", ok: false, detail: (error as Error).message });
  } finally {
    await closePool();
  }

  try {
    const db = await connectFalkorDB();
    try {
      results.push(...(await runGraphSmoke(db)));
    } finally {
      await db.close();
    }
  } catch (error) {
    results.push({ name: "falkordb", ok: false, detail: (error as Error).message });
  }

  return printResults(results);
}

process.exitCode = (await main()) ? 0 : 1;
