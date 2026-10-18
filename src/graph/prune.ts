import type { FalkorDB } from "falkordb";
import type pg from "pg";
import { falkordbConfig } from "@/config/server-env";
import { markPruned, readPruneCandidates } from "@/graph/build.db";

// Deletes FalkorDB graphs of builds no request can still use. A request pins its build when it
// starts and finishes in well under a minute, so a grace period after retirement is enough.
export const PRUNE_DEFAULTS = { keep: 1, graceMinutes: 10 } as const;

export type PruneOptions = { keep?: number; graceMinutes?: number; dryRun?: boolean; now?: Date };
export type PruneReport = {
  active: string | null;
  pruned: { buildId: string; graphName: string; graphExisted: boolean }[];
  kept: { buildId: string; reason: "rollback" | "grace" | "foreign_name" }[];
  dryRun: boolean;
};

export async function pruneGraphs(pool: pg.Pool, db: FalkorDB, options: PruneOptions = {}): Promise<PruneReport> {
  const keep = options.keep ?? PRUNE_DEFAULTS.keep;
  const graceMs = (options.graceMinutes ?? PRUNE_DEFAULTS.graceMinutes) * 60_000;
  const now = options.now ?? new Date();
  // Only graphs under this environment's prefix: a row naming another prefix is never touched.
  const prefix = `${falkordbConfig().graphPrefix}__`;
  const report: PruneReport = { active: null, pruned: [], kept: [], dryRun: options.dryRun ?? false };

  const client = await pool.connect();
  const chosen: { buildId: string; graphName: string }[] = [];
  try {
    // The app_state row lock serialises this with activation: once marked, a build cannot be
    // activated, and the active build is never a candidate.
    await client.query("BEGIN");
    const { active, candidates } = await readPruneCandidates(client);
    report.active = active;
    let rollbackKept = 0;
    for (const candidate of candidates) {
      if (candidate.state === "checked" && rollbackKept < keep) {
        rollbackKept++;
        report.kept.push({ buildId: candidate.buildId, reason: "rollback" });
      } else if (now.getTime() - candidate.since.getTime() < graceMs) {
        report.kept.push({ buildId: candidate.buildId, reason: "grace" });
      } else if (!candidate.graphName.startsWith(prefix)) {
        report.kept.push({ buildId: candidate.buildId, reason: "foreign_name" });
      } else {
        chosen.push(candidate);
      }
    }
    if (!report.dryRun) await markPruned(client, chosen.map((build) => build.buildId));
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const existing = new Set(await db.list());
  for (const build of chosen) {
    const graphExisted = existing.has(build.graphName);
    if (graphExisted && !report.dryRun) await db.selectGraph(build.graphName).delete();
    report.pruned.push({ ...build, graphExisted });
  }
  return report;
}
