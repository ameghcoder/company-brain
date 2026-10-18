import type { FalkorDB, Graph } from "falkordb";
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
export type GraphRequest = Exclude<ToolRequest, { intent: "resolve_alias" }>;
export type PinnedGraph = { buildId: string; graph: Graph };
export type PinResult<T> = { ok: true; buildId: string; value: T } | { ok: false; buildId: string | null; note: string };

// Pins the active build once and runs `fn` against it, so every tool call made for one question
// sees the same graph. Any graph-side failure becomes a note for an `unavailable` outcome; there
// is no fallback that answers from Postgres.
export async function withPinnedGraph<T>(pool: pg.Pool, options: RunOptions, fn: (pinned: PinnedGraph) => Promise<T>): Promise<PinResult<T>> {
  const active = await readActiveBuild(pool);
  if (!active) return { ok: false, buildId: null, note: "No graph build is active; run pnpm graph:publish." };
  let db: FalkorDB;
  try {
    db = await (options.connect ?? connectFalkorDB)();
  } catch {
    return { ok: false, buildId: active.buildId, note: "The graph database is unreachable." };
  }
  try {
    if (!(await db.list()).includes(active.graphName)) return { ok: false, buildId: active.buildId, note: "The active build's graph is missing." };
    const value = await fn({ buildId: active.buildId, graph: db.selectGraph(active.graphName) });
    return { ok: true, buildId: active.buildId, value };
  } catch (error) {
    return { ok: false, buildId: active.buildId, note: `The graph query failed: ${(error as Error).message}` };
  } finally {
    await db.close().catch(() => undefined);
  }
}

// Runs one fixed graph tool on a pinned build and hydrates the chunks it cites. Throws on any
// graph or source-store failure; callers turn that into `unavailable`.
export async function executeTool(pool: pg.Pool, pinned: PinnedGraph, request: GraphRequest): Promise<ToolResponse> {
  let result: ToolResult<unknown>;
  switch (request.intent) {
    case "owner":
      result = await getOwner(pinned.graph, request);
      break;
    case "explain":
      result = await explainDecision(pinned.graph, request);
      break;
    case "changes":
      result = await getChanges(pinned.graph, request);
      break;
    case "timeline":
      result = await getTimeline(pinned.graph, request);
      break;
  }
  const sources = await hydrateEvidence(pool, collectEvidence(result.facts));
  return {
    intent: request.intent,
    build_id: pinned.buildId,
    outcome: result.outcome,
    facts: result.facts,
    paths: dedupePaths(result.paths),
    sources,
    notes: result.notes,
    truncated: result.truncated,
  } as ToolResponse;
}

export function unavailableResponse(intent: GraphRequest["intent"], buildId: string | null, note: string): ToolResponse {
  return { intent, build_id: buildId, outcome: "unavailable", facts: null, paths: [], sources: [], notes: [note], truncated: false };
}

// Validates a structured request and runs it as a single-step question.
export async function runRequest(pool: pg.Pool, input: unknown, options: RunOptions = {}): Promise<ToolResponse> {
  const parsed = toolRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new RequestValidationError(`Invalid request: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ")}`);
  }
  const request = parsed.data;
  if (request.intent === "resolve_alias") return resolveAliasRequest(pool, request);
  const pinned = await withPinnedGraph(pool, options, (graph) => executeTool(pool, graph, request));
  return pinned.ok ? pinned.value : unavailableResponse(request.intent, pinned.buildId, pinned.note);
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
