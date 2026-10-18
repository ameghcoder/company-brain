import { migrate } from "@/db/migrate";
import { closePool, getPool } from "@/db/pool";

try {
  const result = await migrate(getPool());
  console.log(`migrations applied: ${result.applied.length ? result.applied.join(", ") : "none"}`);
  console.log(`already applied: ${result.alreadyApplied.length}`);
} catch (error) {
  console.error(`db:migrate failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
