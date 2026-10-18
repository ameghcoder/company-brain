import { access } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import type { Claim, OwnershipClaim } from "@/contracts/claims";
import { EXTRACTION_SCHEMA_VERSION, extractionJsonSchema, type UnresolvedMention } from "@/contracts/extraction";
import { applyReviews, readApprovals } from "@/extract/approvals";
import { buildClaim, type SourceChunk } from "@/extract/build-claims";
import { extractionRunId, registryRevision, type ExtractionConfig } from "@/extract/cache-key";
import { readApprovedClaims, writeClaims, type ClaimWriteResult } from "@/extract/claims.db";
import { readProseDocuments, readRegistryEntities, readRuns, recordRunAttempt, type RunStatus } from "@/extract/extraction.db";
import { interpretRun, parseExtractionOutput, type ExtractionProblem, type LinkHints } from "@/extract/interpret";
import { linkClaims } from "@/extract/link";
import type { ExtractionModel } from "@/extract/model";
import { buildPrompt, PROMPT_VERSION } from "@/extract/prompt";
import { validateClaims } from "@/extract/validate-claims";
import { buildWindows, type ExtractionWindow } from "@/extract/windows";
import { CHUNKER_VERSIONS } from "@/ingest/chunk";
import { readSelectedChunks } from "@/ingest/ingest.db";
import type { Manifest } from "@/ingest/manifest";
import { readTopicRegistry } from "@/ingest/registry";
import { readEntities } from "@/ingest/registry.db";

export const APPROVALS_PATH = "review/extracted-approvals.json";

export type ExtractOptions = {
  // Without a model nothing is called: only runs already stored are interpreted.
  model?: ExtractionModel;
  modelId: string;
  promptVersion?: string;
  schemaVersion?: string;
  // Persist the materialised claims; false is a dry run for the review report.
  write: boolean;
};

export type RunSummary = { runId: string; documentId: string; windowIndex: number; status: RunStatus | "missing"; error: string | null; attempts: number };

export type ExtractionSummary = {
  config: ExtractionConfig;
  windows: number;
  reused: number;
  called: number;
  runs: RunSummary[];
  claims: Claim[];
  notes: Map<string, string[]>;
  problems: ExtractionProblem[];
  mentions: (UnresolvedMention & { runId: string; documentId: string })[];
  written?: ClaimWriteResult;
};

export async function extractClaims(pool: pg.Pool, manifest: Manifest, options: ExtractOptions): Promise<ExtractionSummary> {
  const topics = await readTopicRegistry(manifest);
  const entities = await readRegistryEntities(pool);
  const documents = await readProseDocuments(pool, Object.values(CHUNKER_VERSIONS));
  const config: ExtractionConfig = {
    schemaVersion: options.schemaVersion ?? EXTRACTION_SCHEMA_VERSION,
    promptVersion: options.promptVersion ?? PROMPT_VERSION,
    model: options.modelId,
    chunkerVersions: CHUNKER_VERSIONS,
    registryRevision: registryRevision({ entities, topics }),
  };
  if (options.model && options.model.id !== options.modelId) throw new Error("Model adapter does not match the configured model ID");

  const windows = documents.flatMap(buildWindows).map((window) => ({ window, runId: extractionRunId(window.hash, config) }));
  const existing = await readRuns(pool, windows.map((item) => item.runId));
  let reused = 0;
  let called = 0;
  for (const { window, runId } of windows) {
    if (existing.get(runId)?.status === "parsed") {
      reused++;
      continue;
    }
    if (!options.model) continue;
    called++;
    await callModel(pool, options.model, window, runId, config, { entities, topics: topics.projects });
  }

  const runs = await readRuns(pool, windows.map((item) => item.runId));
  const runSummaries: RunSummary[] = windows.map(({ window, runId }) => {
    const run = runs.get(runId);
    return { runId, documentId: window.document.documentId, windowIndex: window.index, status: run?.status ?? "missing", error: run?.error ?? null, attempts: run?.attempts ?? 0 };
  });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const materialised = await materialise(client, manifest, windows, runs, topics);
    const written = options.write ? await writeClaims(client, materialised.claims, { origins: ["extracted"], note: "No longer produced by the current extraction runs" }) : undefined;
    await client.query(options.write ? "COMMIT" : "ROLLBACK");
    return { config, windows: windows.length, reused, called, runs: runSummaries, ...materialised, written };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function callModel(
  pool: pg.Pool,
  model: ExtractionModel,
  window: ExtractionWindow,
  runId: string,
  config: ExtractionConfig,
  registry: Parameters<typeof buildPrompt>[1],
): Promise<void> {
  const run = { runId, documentId: window.document.documentId, versionId: window.document.versionId, windowIndex: window.index, windowHash: window.hash, config };
  const prompt = buildPrompt(window, registry);
  let reply;
  try {
    reply = await model.complete({ ...prompt, schemaName: "claim_proposals", schema: extractionJsonSchema() });
  } catch (error) {
    await recordRunAttempt(pool, { ...run, status: "failed", rawOutput: null, servedModel: null, error: `${(error as Error).name}: ${(error as Error).message}`, newAttempt: true });
    return;
  }
  // Store the raw response first: if parsing or anything after it fails, the output is not lost.
  await recordRunAttempt(pool, { ...run, status: "invalid", rawOutput: reply.content, servedModel: reply.servedModel, error: "not yet parsed", newAttempt: true });
  const parsed = parseExtractionOutput(reply.content);
  await recordRunAttempt(pool, {
    ...run,
    status: parsed.ok ? "parsed" : "invalid",
    rawOutput: reply.content,
    servedModel: reply.servedModel,
    error: parsed.ok ? null : parsed.error,
    newAttempt: false,
  });
}

// Deterministic: the same parsed runs and approvals file always produce the same claims.
async function materialise(
  client: pg.PoolClient,
  manifest: Manifest,
  windows: { window: ExtractionWindow; runId: string }[],
  runs: Awaited<ReturnType<typeof readRuns>>,
  topics: Awaited<ReturnType<typeof readTopicRegistry>>,
) {
  const timezone = manifest.company.timezone;
  const chunksByDocument = new Map<string, SourceChunk[]>();
  for (const chunk of await readSelectedChunks(client, Object.values(CHUNKER_VERSIONS))) {
    chunksByDocument.set(chunk.documentId, [...(chunksByDocument.get(chunk.documentId) ?? []), chunk]);
  }

  const problems: ExtractionProblem[] = [];
  const mentions: ExtractionSummary["mentions"] = [];
  const notes = new Map<string, string[]>();
  const hints = new Map<string, LinkHints>();
  const note = (claimId: string, message: string) => notes.set(claimId, [...(notes.get(claimId) ?? []), message]);
  let claims: Claim[] = [];

  for (const { window, runId } of windows) {
    const run = runs.get(runId);
    if (run?.status !== "parsed" || run.rawOutput === null) continue;
    const parsed = parseExtractionOutput(run.rawOutput);
    if (!parsed.ok) {
      problems.push({ runId, documentId: window.document.documentId, message: `stored output no longer parses: ${parsed.error}` });
      continue;
    }
    const interpreted = interpretRun(runId, window, parsed.output);
    problems.push(...interpreted.problems);
    mentions.push(...interpreted.mentions);
    for (const item of interpreted.drafts) {
      const built = buildClaim(item.draft, chunksByDocument, timezone);
      if (!built.ok) {
        for (const error of built.errors) problems.push({ runId, documentId: window.document.documentId, claimId: item.draft.claim_id, message: error });
        continue;
      }
      // The model must cite the chunk that actually contains its quote.
      const misplaced = built.claim.evidence.filter((evidence) => {
        const cited = item.citedChunks.get(`${evidence.role}|${evidence.quote}`);
        return cited !== undefined && cited !== evidence.chunk_id;
      });
      if (misplaced.length) {
        problems.push({ runId, documentId: window.document.documentId, claimId: item.draft.claim_id, message: `quote "${misplaced[0]?.quote}" is not in the chunk it cites` });
        continue;
      }
      claims.push(built.claim);
      hints.set(built.claim.claim_id, item.hints);
      item.notes.forEach((message) => note(built.claim.claim_id, message));
    }
  }

  const structured = await readApprovedClaims(client, ["structured"]);
  const linked = linkClaims(claims, hints, structured.filter((claim): claim is OwnershipClaim => claim.kind === "ownership"));
  linked.problems.forEach((problem) => note(problem.claimId, problem.message));
  claims = linked.claims;

  const approvalsFile = path.join(manifest.root, APPROVALS_PATH);
  const hasApprovals = await access(approvalsFile).then(() => true, () => false);
  if (hasApprovals) {
    const reviewed = applyReviews(claims, await readApprovals(approvalsFile), timezone);
    claims = reviewed.claims;
    reviewed.problems.forEach((problem) => (claims.some((claim) => claim.claim_id === problem.claimId) ? note(problem.claimId, problem.message) : problems.push({ runId: "-", documentId: "-", claimId: problem.claimId, message: problem.message })));
  }

  // Claims for unknown projects cannot be stored (foreign key); everything else is kept for review.
  const entities = new Map((await readEntities(client)).map((entity) => [entity.entityId, entity]));
  for (const claim of claims.filter((item) => entities.get(item.project_id)?.kind !== "project")) {
    problems.push({ runId: "-", documentId: claim.evidence[0]?.document_id ?? "-", claimId: claim.claim_id, message: `unknown project ${claim.project_id}` });
  }
  claims = claims.filter((claim) => entities.get(claim.project_id)?.kind === "project");

  // An approval never overrides validation: approved claims with problems drop back to pending
  // until the approved set is consistent on its own.
  for (let pass = 0; pass < 10; pass++) {
    const errors = validateClaims([...structured, ...claims], entities, topics);
    const blocked = new Map<string, string[]>();
    for (const error of errors) {
      for (const claim of claims) {
        if (error.startsWith(`${claim.claim_id}: `) || (error.includes("cycle:") && error.includes(claim.claim_id))) {
          blocked.set(claim.claim_id, [...(blocked.get(claim.claim_id) ?? []), error.replace(`${claim.claim_id}: `, "")]);
        }
      }
    }
    if (pass === 0) for (const [claimId, messages] of blocked) messages.forEach((message) => note(claimId, `validation: ${message}`));
    const approvedBlocked = claims.filter((claim) => claim.review_status === "approved" && blocked.has(claim.claim_id));
    if (!approvedBlocked.length) break;
    claims = claims.map((claim) =>
      approvedBlocked.includes(claim)
        ? { ...claim, review_status: "pending", review_note: `Approval blocked: ${(blocked.get(claim.claim_id) ?? []).join("; ")}` }
        : claim,
    );
  }

  return { claims: claims.sort((a, b) => a.claim_id.localeCompare(b.claim_id)), notes, problems, mentions };
}
