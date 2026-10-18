import type { FalkorDB } from "falkordb";
import type pg from "pg";
import { checkGraph, type CheckReport } from "@/graph/check";
import { readBuild, setActiveBuild } from "@/graph/build.db";
import { rebuildGraph, type BuildOutcome } from "@/graph/build";
import type { TopicRegistry } from "@/ingest/registry";

export async function activateGraph(pool: pg.Pool, db: FalkorDB, buildId: string): Promise<{ previous: string | null }> {
  const build = await readBuild(pool, buildId);
  if (!build) throw new Error(`Unknown build ${buildId}`);
  // Never point questions at a graph that has disappeared from FalkorDB.
  if (!(await db.list()).includes(build.graphName)) throw new Error(`Graph ${build.graphName} for build ${buildId} does not exist`);
  const client = await pool.connect();
  try {
    return await setActiveBuild(client, buildId);
  } finally {
    client.release();
  }
}

export type PublishResult = { build: BuildOutcome; report: CheckReport; activated: boolean; previous: string | null };

// rebuild -> check -> activate, as three distinct steps; a failed check leaves the current build active.
export async function publishGraph(pool: pg.Pool, db: FalkorDB, topics: TopicRegistry): Promise<PublishResult> {
  const build = await rebuildGraph(pool, db, topics);
  const report = await checkGraph(pool, db, build.buildId);
  if (!report.ok) return { build, report, activated: false, previous: null };
  const { previous } = await activateGraph(pool, db, build.buildId);
  return { build, report, activated: true, previous };
}
