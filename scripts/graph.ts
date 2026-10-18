import { closePool, getPool } from "@/db/pool";
import { activateGraph, publishGraph } from "@/graph/activate";
import { readActiveBuild } from "@/graph/build.db";
import { rebuildGraph } from "@/graph/build";
import { checkGraph, type CheckReport } from "@/graph/check";
import { connectFalkorDB } from "@/graph/client";
import { DEFAULT_FIXTURE_ROOT } from "@/ingest/load";
import { loadManifest } from "@/ingest/manifest";
import { readTopicRegistry } from "@/ingest/registry";
import { printResults } from "@/smoke/check-result";

// Usage: tsx scripts/graph.ts <rebuild | check <buildId> | activate <buildId> | publish | status>
// Builds read Postgres only; no model or embedding provider is called.
const [command, buildId] = process.argv.slice(2);

function printReport(report: CheckReport) {
  printResults(report.checks);
  const conflicts = report.conflicts as { projectId: string; role: string; claimIds: string[] }[];
  for (const conflict of conflicts) console.log(`INFO  ownership conflict ${conflict.projectId}/${conflict.role}: ${conflict.claimIds.join(" vs ")}`);
}

async function main(): Promise<boolean> {
  const pool = getPool();
  const db = await connectFalkorDB();
  try {
    const topics = await readTopicRegistry(await loadManifest(DEFAULT_FIXTURE_ROOT));
    switch (command) {
      case "rebuild": {
        const build = await rebuildGraph(pool, db, topics);
        console.log(`built ${build.buildId} -> ${build.graphName} (not active; run check, then activate)`);
        return true;
      }
      case "check": {
        if (!buildId) throw new Error("check needs a build id");
        const report = await checkGraph(pool, db, buildId);
        printReport(report);
        console.log(report.ok ? `build ${buildId} checked` : `build ${buildId} FAILED its checks`);
        return report.ok;
      }
      case "activate": {
        if (!buildId) throw new Error("activate needs a build id");
        const { previous } = await activateGraph(pool, db, buildId);
        console.log(`active build: ${buildId} (previous: ${previous ?? "none"})`);
        return true;
      }
      case "publish": {
        const result = await publishGraph(pool, db, topics);
        printReport(result.report);
        console.log(
          result.activated
            ? `active build: ${result.build.buildId} (previous: ${result.previous ?? "none"})`
            : `build ${result.build.buildId} FAILED its checks; the active build is unchanged`,
        );
        return result.activated;
      }
      case "status": {
        const active = await readActiveBuild(pool);
        console.log(active ? `active build: ${active.buildId} (${active.graphName})` : "no active build");
        return true;
      }
      default:
        console.error("usage: tsx scripts/graph.ts <rebuild | check <buildId> | activate <buildId> | publish | status>");
        return false;
    }
  } finally {
    await db.close();
    await closePool();
  }
}

try {
  process.exitCode = (await main()) ? 0 : 1;
} catch (error) {
  console.error(`graph ${command ?? ""} failed: ${(error as Error).message}`);
  process.exitCode = 1;
}
