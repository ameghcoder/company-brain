import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { FalkorDB } from "falkordb";
import type pg from "pg";
import type { DecisionProposal, ExtractionOutput, OwnershipProposal } from "@/contracts/extraction";
import { closePool } from "@/db/pool";
import type { ExtractionModel, ExtractionRequest } from "@/extract/model";
import { APPROVALS_PATH, extractClaims, type ExtractionSummary } from "@/extract/run-extraction";
import { publishGraph } from "@/graph/activate";
import { connectFalkorDB } from "@/graph/client";
import { DEFAULT_FIXTURE_ROOT, loadFixtures } from "@/ingest/load";
import { loadManifest, type Manifest } from "@/ingest/manifest";
import { readTopicRegistry } from "@/ingest/registry";
import { deleteTestGraphs, useFreshTestDatabase, useTestGraphs } from "@/test-support/test-db";

// SCRIPTED TEST DOUBLE, not a real model. It returns hand-written proposals so these tests can
// exercise our own pipeline (storage, retries, interpretation, linking, review, claim sets).
// Nothing here measures real extraction quality; that needs the live provider (issue #2).

type Payload = { document: { title: string }; chunks: { chunk_id: string; text: string }[] };
type Script = (payload: Payload, quote: (text: string) => { chunk_id: string; quote: string }) => ExtractionOutput | string | Error;

const empty: ExtractionOutput = { decisions: [], ownership: [], unresolved_mentions: [] };
const decision = (fields: Partial<DecisionProposal> & Pick<DecisionProposal, "project_id" | "topic" | "choice" | "evidence">): DecisionProposal => ({
  status: "decided",
  title: `Use ${fields.choice}`,
  decided_on: null,
  effective_on: null,
  rationale: null,
  decided_by: null,
  replaces_choice: null,
  uncertainty: null,
  ...fields,
});
const ownership = (fields: Partial<OwnershipProposal> & Pick<OwnershipProposal, "project_id" | "role" | "assignee_id" | "evidence">): OwnershipProposal => ({
  effective_from: null,
  effective_to: null,
  takes_over_from: null,
  uncertainty: null,
  ...fields,
});

const SCRIPTS: Record<string, Script> = {
  "Atlas ADR-001: Payments provider": (_payload, q) => ({
    ...empty,
    decisions: [
      decision({
        project_id: "proj-atlas",
        topic: "payments.provider",
        choice: "Braintree",
        decided_on: "2026-08-12",
        effective_on: "2026-08-12",
        rationale: "Existing contract",
        decided_by: "p-dana-ortiz",
        evidence: [
          { ...q("Atlas will use Braintree as its payments provider, starting immediately."), supports: "decision" },
          { ...q("We already have an enterprise contract with Braintree"), supports: "rationale" },
          { ...q("Approved by: Dana Ortiz"), supports: "decided_by" },
        ],
      }),
    ],
  }),
  "Atlas weekly sync, 2026-09-03": (_payload, q) => ({
    decisions: [
      decision({
        project_id: "proj-atlas",
        topic: "payments.provider",
        choice: "Stripe",
        status: "proposed",
        decided_on: "2026-09-03T10:02",
        replaces_choice: "Braintree",
        // The double deliberately labels proposal evidence as "decision"; the pipeline must relabel it.
        evidence: [{ ...q("If that happens we might switch to Stripe."), supports: "decision" }],
      }),
    ],
    ownership: [],
    unresolved_mentions: [{ text: "Alex", chunk_id: q("Alex, please put together").chunk_id, candidate_ids: ["p-alex-chen", "p-alex-rivera"], note: "two people are called Alex" }],
  }),
  "Atlas payments provider review, 2026-10-02": (_payload, q) => ({
    ...empty,
    decisions: [
      decision({
        project_id: "proj-atlas",
        topic: "payments.provider",
        choice: "Stripe",
        decided_on: "2026-10-02T14:08",
        effective_on: "2026-10-06",
        decided_by: "p-dana-ortiz",
        rationale: "Multi-currency payouts for the EU launch",
        replaces_choice: "braintree",
        evidence: [
          { ...q("Decision: Atlas moves its payments provider from Braintree to Stripe, effective October 6."), supports: "decision" },
          { ...q("Dana Ortiz: Decision:"), supports: "decided_by" },
          { ...q("Our Braintree plan cannot do multi-currency payouts, and Stripe can."), supports: "rationale" },
        ],
      }),
    ],
  }),
  "Atlas fraud screening": (_payload, q) => ({
    ...empty,
    decisions: [
      decision({
        project_id: "proj-atlas",
        topic: "payments.fraud_screening",
        choice: "Sift",
        decided_on: "2026-10-05",
        effective_on: "2026-10-05",
        // Similar wording, different topic: must not link to the payments provider decisions.
        replaces_choice: "Braintree",
        evidence: [{ ...q("Atlas will screen card payments with Sift, effective October 5, 2026."), supports: "decision" }],
      }),
    ],
  }),
  "Atlas migration handoff": (_payload, q) => ({
    ...empty,
    ownership: [
      ownership({
        project_id: "proj-atlas",
        role: "migration.owner",
        assignee_id: "p-marcus-lee",
        effective_from: "2026-10-15",
        takes_over_from: "p-priya-raman",
        evidence: [{ ...q("Effective October 15, Marcus Lee takes over as migration owner for Atlas."), supports: "assignment" }],
      }),
    ],
  }),
  "Cobalt warehouse platform": (payload, q) => ({
    ...empty,
    decisions: [
      // 0: out-of-registry topic and unknown decider: stored only as a pending claim with notes.
      decision({ project_id: "proj-cobalt", topic: "crm.vendor", choice: "Snowflake", decided_by: "p-ghost", evidence: [{ ...q("Decision: Cobalt will use Snowflake"), supports: "decision" }] }),
      // 1: cites a chunk outside this window.
      decision({ project_id: "proj-cobalt", topic: "warehouse.platform", choice: "Snowflake", evidence: [{ chunk_id: "some-other-doc@0/md-sections-v1/0", quote: "Snowflake", supports: "decision" }] }),
      // 2: quote not present in the cited chunk.
      decision({ project_id: "proj-cobalt", topic: "warehouse.platform", choice: "BigQuery", evidence: [{ chunk_id: payload.chunks[0]?.chunk_id ?? "", quote: "Cobalt will use BigQuery", supports: "decision" }] }),
    ],
  }),
};

function scriptedModel(id: string, overrides: Record<string, Script> = {}): ExtractionModel & { calls: string[] } {
  const calls: string[] = [];
  return {
    id,
    calls,
    async complete(request: ExtractionRequest) {
      const payload = JSON.parse(request.user) as Payload;
      calls.push(payload.document.title);
      const quote = (text: string) => {
        const chunk = payload.chunks.find((item) => item.text.includes(text));
        if (!chunk) throw new Error(`test script quote not in window: ${text}`);
        return { chunk_id: chunk.chunk_id, quote: text };
      };
      const script = overrides[payload.document.title] ?? SCRIPTS[payload.document.title];
      const result = script ? script(payload, quote) : empty;
      if (result instanceof Error) throw result;
      return { content: typeof result === "string" ? result : JSON.stringify(result), servedModel: `${id}-test-double` };
    },
  };
}

const findDecision = (summary: ExtractionSummary, choice: string, topic = "payments.provider") =>
  summary.claims.find((claim) => claim.kind === "decision" && claim.payload.choice === choice && claim.topic === topic && claim.payload.lifecycle === "decided");

describe("extraction pipeline with a scripted test double (real Postgres + FalkorDB)", () => {
  let pool: pg.Pool;
  let db: FalkorDB;
  let root: string;
  let manifest: Manifest;

  before(async () => {
    pool = await useFreshTestDatabase();
    db = await connectFalkorDB();
    await useTestGraphs(db);
    root = await mkdtemp(path.join(tmpdir(), "company-brain-extract-"));
    await cp(DEFAULT_FIXTURE_ROOT, root, { recursive: true });
    await loadFixtures(pool, root);
    manifest = await loadManifest(root);
  });
  after(async () => {
    await deleteTestGraphs(db);
    await db.close();
    await closePool();
    await rm(root, { recursive: true, force: true });
  });

  it("stores raw output before interpreting it and retries failed or invalid runs", async () => {
    const flaky = scriptedModel("model-a", {
      "Beacon release plan, Q4": () => new Error("connect ECONNRESET"),
      "Beacon analytics provider": () => "this is not JSON",
    });
    const first = await extractClaims(pool, manifest, { model: flaky, modelId: "model-a", write: true });
    assert.equal(first.called, first.windows);
    const status = (summary: ExtractionSummary, documentId: string) => summary.runs.find((run) => run.documentId === documentId);
    assert.equal(status(first, "beacon-release-plan")?.status, "failed");
    assert.equal(status(first, "beacon-analytics-decision")?.status, "invalid");
    const stored = await pool.query("SELECT raw_output, error FROM extraction_runs WHERE document_id = 'beacon-analytics-decision'");
    assert.equal(stored.rows[0].raw_output, "this is not JSON");
    assert.match(stored.rows[0].error, /not JSON/);

    const retry = await extractClaims(pool, manifest, { model: scriptedModel("model-a"), modelId: "model-a", write: true });
    assert.equal(retry.called, 2, "only the failed and invalid runs are retried");
    assert.ok(retry.runs.every((run) => run.status === "parsed"));
    assert.equal(status(retry, "beacon-release-plan")?.attempts, 2);
  });

  it("reuses parsed runs and re-extracts when the prompt version or model changes", async () => {
    const again = scriptedModel("model-a");
    const reused = await extractClaims(pool, manifest, { model: again, modelId: "model-a", write: false });
    assert.equal(reused.called, 0);
    assert.equal(again.calls.length, 0);

    const newPrompt = await extractClaims(pool, manifest, { model: scriptedModel("model-a"), modelId: "model-a", promptVersion: "extract-prompt-test", write: false });
    assert.equal(newPrompt.called, newPrompt.windows);
    const newModel = await extractClaims(pool, manifest, { model: scriptedModel("model-b"), modelId: "model-b", write: false });
    assert.equal(newModel.called, newModel.windows);
    assert.notDeepEqual(newModel.runs.map((run) => run.runId), reused.runs.map((run) => run.runId));
  });

  it("records invalid proposals as problems instead of claims", async () => {
    const summary = await extractClaims(pool, manifest, { modelId: "model-a", write: true });
    const messages = summary.problems.map((problem) => problem.message);
    assert.ok(messages.some((message) => /cites chunk some-other-doc@0\/md-sections-v1\/0, which is not in this window/.test(message)), messages.join("\n"));
    assert.ok(messages.some((message) => /quote not found in cobalt-warehouse-note/.test(message)), messages.join("\n"));
    assert.ok(!summary.claims.some((claim) => claim.kind === "decision" && claim.payload.choice === "BigQuery"));

    const outOfRegistry = summary.claims.find((claim) => claim.topic === "crm.vendor");
    assert.ok(outOfRegistry);
    assert.equal(outOfRegistry.review_status, "pending");
    const notes = summary.notes.get(outOfRegistry.claim_id) ?? [];
    assert.ok(notes.some((note) => /not a registered decision topic/.test(note)), notes.join("\n"));
    assert.ok(notes.some((note) => /decided_by p-ghost is not a known person/.test(note)), notes.join("\n"));
    assert.equal(summary.mentions[0]?.text, "Alex");
  });

  it("keeps proposals as proposals and links replacements and handoffs only within a topic", async () => {
    const summary = await extractClaims(pool, manifest, { modelId: "model-a", write: false });
    const proposal = summary.claims.find((claim) => claim.kind === "decision" && claim.payload.lifecycle === "proposed");
    assert.ok(proposal && proposal.kind === "decision");
    assert.deepEqual(proposal.evidence.map((item) => item.role), ["proposal"]);

    const stripe = findDecision(summary, "Stripe");
    const braintree = findDecision(summary, "Braintree");
    assert.ok(stripe && braintree);
    const supersessions = summary.claims.filter((claim) => claim.kind === "supersession");
    assert.deepEqual(
      supersessions.map((claim) => claim.kind === "supersession" && [claim.payload.new_decision_id, claim.payload.old_decision_id]),
      [[stripe.claim_id, braintree.claim_id]],
      "only Stripe replaces Braintree; the proposal and the fraud decision link nothing",
    );
    const sift = findDecision(summary, "Sift", "payments.fraud_screening");
    assert.ok(sift);
    assert.ok((summary.notes.get(sift.claim_id) ?? []).some((note) => /no earlier decided decision on proj-atlas\/payments.fraud_screening/.test(note)));

    const marcus = summary.claims.find((claim) => claim.kind === "ownership" && claim.payload.assignee_id === "p-marcus-lee");
    assert.ok(marcus && marcus.kind === "ownership");
    assert.equal(marcus.payload.handoff_from, "own-asg-001");
    assert.ok(marcus.evidence.some((item) => item.role === "handoff"));
  });

  it("applies reviews from the approvals file, blocks invalid approvals, and keeps IDs stable", async () => {
    const draft = await extractClaims(pool, manifest, { modelId: "model-a", write: false });
    const stripe = findDecision(draft, "Stripe");
    const braintree = findDecision(draft, "Braintree");
    const sift = findDecision(draft, "Sift", "payments.fraud_screening");
    const marcus = draft.claims.find((claim) => claim.kind === "ownership");
    const supersession = draft.claims.find((claim) => claim.kind === "supersession");
    const proposal = draft.claims.find((claim) => claim.kind === "decision" && claim.payload.lifecycle === "proposed");
    const crm = draft.claims.find((claim) => claim.topic === "crm.vendor");
    assert.ok(stripe && braintree && sift && marcus && supersession && proposal && crm);

    await writeFile(
      path.join(root, APPROVALS_PATH),
      JSON.stringify({
        reviews: [
          { claim_id: braintree.claim_id, action: "approve" },
          { claim_id: stripe.claim_id, action: "approve" },
          { claim_id: supersession.claim_id, action: "approve" },
          { claim_id: proposal.claim_id, action: "approve", note: "a proposal, not a decision" },
          { claim_id: marcus.claim_id, action: "approve" },
          { claim_id: sift.claim_id, action: "correct", note: "title from the source", set: { title: "Screen Atlas card payments with Sift" } },
          { claim_id: crm.claim_id, action: "approve", note: "should be blocked by validation" },
        ],
      }),
    );
    const applied = await extractClaims(pool, manifest, { modelId: "model-a", write: true });
    const statusOf = async (claimId: string) =>
      (await pool.query<{ review_status: string; review_note: string | null }>("SELECT review_status, review_note FROM claims WHERE claim_id = $1", [claimId])).rows[0];

    for (const claim of [braintree, stripe, supersession, proposal, marcus]) assert.equal((await statusOf(claim.claim_id))?.review_status, "approved", claim.claim_id);
    const corrected = await statusOf(sift.claim_id);
    assert.equal(corrected?.review_status, "approved");
    assert.match(corrected?.review_note ?? "", /Corrected \(title\)/);
    const blocked = await statusOf(crm.claim_id);
    assert.equal(blocked?.review_status, "pending");
    assert.match(blocked?.review_note ?? "", /Approval blocked: topic crm.vendor is not a registered decision topic/);

    const again = await extractClaims(pool, manifest, { modelId: "model-a", write: true });
    assert.deepEqual(again.claims.map((claim) => [claim.claim_id, claim.review_status]), applied.claims.map((claim) => [claim.claim_id, claim.review_status]));
    assert.deepEqual(again.written, { inserted: 0, updated: 0, unchanged: applied.claims.length, retired: 0 });
  });

  it("builds a graph from the extracted claim set without fixture claims", async () => {
    const topics = await readTopicRegistry(manifest);
    const extracted = await publishGraph(pool, db, topics, "extracted");
    assert.equal(extracted.activated, true, JSON.stringify(extracted.report.checks.filter((check) => !check.ok)));
    const graph = db.selectGraph(extracted.build.graphName);
    const ids = ((await graph.roQuery<{ id: string }>("MATCH (c:Claim) RETURN c.id AS id")).data ?? []).map((row) => row.id);
    assert.ok(!ids.includes("dec-atlas-stripe"), "fixture-reviewed claims are not in an extracted build");
    assert.ok(ids.includes("own-asg-001"), "structured claims belong to both claim sets");
    assert.ok(ids.every((id) => id.startsWith("x-") || id.startsWith("own-asg-")), ids.join(", "));
    const pending = await pool.query("SELECT claim_id FROM claims WHERE origin = 'extracted' AND review_status <> 'approved'");
    for (const row of pending.rows) assert.ok(!ids.includes(row.claim_id), `${row.claim_id} is not approved and must not be projected`);

    const fixture = await publishGraph(pool, db, topics);
    const fixtureIds = ((await db.selectGraph(fixture.build.graphName).roQuery<{ id: string }>("MATCH (c:Claim) RETURN c.id AS id")).data ?? []).map((row) => row.id);
    assert.ok(fixtureIds.includes("dec-atlas-stripe") && !fixtureIds.some((id) => id.startsWith("x-")));
  });
});
