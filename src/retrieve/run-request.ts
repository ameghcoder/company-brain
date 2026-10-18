import type { FalkorDB } from "falkordb";
import type pg from "pg";
import { toolRequestSchema, type PathEdge, type ToolRequest, type ToolResponse } from "@/contracts/graph-tools";
import { readActiveBuild } from "@/graph/build.db";
import { connectFalkorDB } from "@/graph/client";
import { readEntitiesById, resolveAlias } from "@/ingest/registry.db";
import { explainDecision, getChanges, getOwner, getTimeline, type ToolResult } from "@/retrieve/graph-tools";
import { collectEvidence, hydrateEvidence } from "@/retrieve/hydrate";

export class RequestValidationError extends Error {
  override name = "RequestValidationError";
}

export type RunOptions = { connect?: () => Promise<FalkorDB> };

// Validates a structured request, pins the active build for the whole request, runs one fixed
// graph tool, and hydrates cited chunks. Any graph-side failure yields `unavailable`; there is no
// fallback that answers from Postgres.
export async function runRequest(pool: pg.Pool, input: unknown, options: RunOptions = {}): Promise<ToolResponse> {
  const parsed = toolRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new RequestValidationError(`Invalid request: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ")}`);
  }
  const request = parsed.data;
  if (request.intent === "resolve_alias") return resolveAliasRequest(pool, request);

  const unavailable = (buildId: string | null, note: string): ToolResponse => ({
    intent: request.intent,
    build_id: buildId,
    outcome: "unavailable",
    facts: null,
    paths: [],
    sources: [],
    notes: [note],
    truncated: false,
  });

  const active = await readActiveBuild(pool);
  if (!active) return unavailable(null, "No graph build is active; run pnpm graph:publish.");

  let db: FalkorDB;
  try {
    db = await (options.connect ?? connectFalkorDB)();
  } catch {
    return unavailable(active.buildId, "The graph database is unreachable.");
  }
  try {
    if (!(await db.list()).includes(active.graphName)) return unavailable(active.buildId, "The active build's graph is missing.");
    const graph = db.selectGraph(active.graphName);
    let result: ToolResult<unknown>;
    switch (request.intent) {
      case "owner":
        result = await getOwner(graph, request);
        break;
      case "explain":
        result = await explainDecision(graph, request);
        break;
      case "changes":
        result = await getChanges(graph, request);
        break;
      case "timeline":
        result = await getTimeline(graph, request);
        break;
    }
    const sources = await hydrateEvidence(pool, collectEvidence(result.facts));
    return {
      intent: request.intent,
      build_id: active.buildId,
      outcome: result.outcome,
      facts: result.facts,
      paths: dedupePaths(result.paths),
      sources,
      notes: result.notes,
      truncated: result.truncated,
    } as ToolResponse;
  } catch (error) {
    return unavailable(active.buildId, `The graph query failed: ${(error as Error).message}`);
  } finally {
    await db.close().catch(() => undefined);
  }
}

async function resolveAliasRequest(pool: pg.Pool, request: Extract<ToolRequest, { intent: "resolve_alias" }>): Promise<ToolResponse> {
  const resolution = await resolveAlias(pool, request.alias, request.kind);
  const ids = resolution.status === "resolved" ? [resolution.entityId] : resolution.status === "ambiguous" ? resolution.candidates : [];
  const candidates = (await readEntitiesById(pool, ids)).map((entity) => ({ id: entity.entityId, name: entity.canonicalName, kind: entity.kind }));
  const outcome = resolution.status === "resolved" ? "answered" : resolution.status === "ambiguous" ? "needs_clarification" : "insufficient_evidence";
  const notes =
    resolution.status === "ambiguous"
      ? [`"${request.alias}" could mean ${candidates.map((candidate) => candidate.name).join(" or ")}. Which one?`]
      : resolution.status === "unknown"
        ? [`No ${request.kind ?? "entity"} is known as "${request.alias}".`]
        : [];
  return { intent: "resolve_alias", build_id: null, outcome, facts: { alias: request.alias, candidates }, paths: [], sources: [], notes, truncated: false };
}

function dedupePaths(paths: PathEdge[]): PathEdge[] {
  const seen = new Set<string>();
  return paths.filter((path) => {
    const key = `${path.from}|${path.rel}|${path.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
