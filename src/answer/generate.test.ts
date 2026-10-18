import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { FalkorDB } from "falkordb";
import type pg from "pg";
import { checkAnswer } from "@/answer/check-answer";
import { buildEvidencePacket, type EvidencePacket } from "@/answer/evidence-packet";
import { deterministicAnswer } from "@/answer/fallback";
import { generateAnswer, MAX_REPAIRS } from "@/answer/generate";
import { toPublicResponse } from "@/answer/public-response";
import type { Answer } from "@/contracts/answer";
import type { Plan } from "@/contracts/planning";
import { closePool } from "@/db/pool";
import { readExpectedCases } from "@/eval/run-eval";
import { readRegistryEntities } from "@/extract/extraction.db";
import { publishGraph } from "@/graph/activate";
import { connectFalkorDB } from "@/graph/client";
import { DEFAULT_FIXTURE_ROOT, loadFixtures } from "@/ingest/load";
import { loadManifest } from "@/ingest/manifest";
import { readTopicRegistry, type TopicRegistry } from "@/ingest/registry";
import type { StructuredModel } from "@/provider/structured-model";
import { askQuestion } from "@/retrieve/ask";
import { runRequest } from "@/retrieve/run-request";
import { deleteTestGraphs, useFreshTestDatabase, useTestGraphs } from "@/test-support/test-db";

// SCRIPTED ANSWER DOUBLE: replies with fixed answers in order, so these tests exercise our
// checks, the repair cap, and the fallback. Real answer quality is measured by eval:questions.
function scriptedModel(replies: (Answer | string | Error | ((packet: EvidencePacket) => Answer))[]): StructuredModel & { calls: number } {
  const model = {
    id: "answer-test-double",
    calls: 0,
    async complete(request: { user: string }) {
      const reply = replies[Math.min(model.calls, replies.length - 1)];
      model.calls++;
      if (reply instanceof Error) throw reply;
      const payload = JSON.parse(request.user) as EvidencePacket | { packet: EvidencePacket };
      const packet = "packet" in payload ? payload.packet : payload;
      const content = typeof reply === "function" ? reply(packet) : reply;
      return { content: typeof content === "string" ? content : JSON.stringify(content), servedModel: "answer-test-double" };
    },
  };
  return model;
}

const TZ = "America/New_York";

describe("answer generation and fallback (real Postgres + FalkorDB)", () => {
  let pool: pg.Pool;
  let db: FalkorDB;
  let topics: TopicRegistry;
  let registry: Awaited<ReturnType<typeof readRegistryEntities>>;
  let ownerPacket: EvidencePacket;

  before(async () => {
    pool = await useFreshTestDatabase();
    db = await connectFalkorDB();
    await useTestGraphs(db);
    await loadFixtures(pool);
    topics = await readTopicRegistry(await loadManifest(DEFAULT_FIXTURE_ROOT));
    assert.equal((await publishGraph(pool, db, topics)).activated, true);
    registry = await readRegistryEntities(pool);
    const response = await runRequest(pool, { intent: "owner", project: "proj-atlas", role: "migration.owner", at: "2026-10-18T12:00:00-04:00" });
    ownerPacket = packetFor("Who owns the Atlas migration?", [{ response, notes: [] }]);
  });
  after(async () => {
    await deleteTestGraphs(db);
    await db.close();
    await closePool();
  });

  const packetFor = (question: string, steps: Parameters<typeof buildEvidencePacket>[0]["steps"]) =>
    buildEvidencePacket({ question, asOfLocal: "2026-10-18T12:00", buildId: "b", steps, names: new Map(registry.map((e) => [e.id, e.name])), timezone: TZ });

  it("passes the checks with the deterministic fallback for every expected case", async () => {
    for (const expected of await readExpectedCases(DEFAULT_FIXTURE_ROOT)) {
      // Alias lookups and searches never answer by themselves, so they never reach a packet.
      if (expected.request.intent === "resolve_alias" || expected.request.intent === "search") continue;
      const response = await runRequest(pool, expected.request);
      const packet = packetFor(expected.question, [{ response, notes: [] }]);
      assert.deepEqual(checkAnswer(deterministicAnswer(packet), packet, registry), [], expected.id);
    }
  });

  it("states the as-of date in the company timezone", async () => {
    const response = await runRequest(pool, { intent: "owner", project: "proj-atlas", role: "migration.owner", at: "2026-10-14T23:59:00-04:00" });
    const packet = packetFor("Who owned it before October 15?", [{ response, notes: [] }]);
    assert.match(packet.facts[0]?.summary ?? "", /as of 2026-10-14/);
  });

  it("quotes each evidence span of a claim, not the first span twice", async () => {
    const response = await runRequest(pool, { intent: "explain", project: "proj-atlas", topic: "payments.provider", at: "2026-10-18T12:00:00-04:00" });
    const packet = packetFor("Why did Atlas switch to Stripe?", [{ response, notes: [] }]);
    const rationale = packet.citations.filter((citation) => citation.claim_id === "dec-atlas-stripe" && citation.role === "rationale");
    assert.ok(rationale.length >= 2, JSON.stringify(rationale));
    assert.equal(new Set(rationale.map((citation) => citation.excerpt)).size, rationale.length, "distinct spans quote distinct text");
    assert.ok(rationale.some((citation) => /multi-currency/.test(citation.excerpt)));
  });

  it("uses a model answer that passes the checks", async () => {
    const model = scriptedModel([(packet) => deterministicAnswer(packet)]);
    const result = await generateAnswer(ownerPacket, model, registry);
    assert.equal(result.source, "model");
    assert.equal(model.calls, 1);
  });

  it("repairs once, then falls back to the verified rendering", async () => {
    const invented: Answer = { items: [{ text: "Marcus Lee owns the Atlas migration.", fact_ids: ["f1"], citation_ids: ["c99"] }] };
    const repaired = await generateAnswer(ownerPacket, scriptedModel([invented, (packet) => deterministicAnswer(packet)]), registry);
    assert.equal(repaired.source, "repaired");
    assert.match(repaired.attempts[0]?.failures.join(" ") ?? "", /c99, which is not in the packet/);

    const stubborn = scriptedModel([invented]);
    const fallback = await generateAnswer(ownerPacket, stubborn, registry);
    assert.equal(fallback.source, "deterministic");
    assert.equal(stubborn.calls, 1 + MAX_REPAIRS, "one generation plus at most one repair");
    assert.deepEqual(checkAnswer(fallback.answer, ownerPacket, registry), []);
    assert.ok(!fallback.answer.items.some((item) => item.citation_ids.includes("c99")), "no unsupported item survives");
  });

  it("falls back immediately on a provider error or unparseable output", async () => {
    const failing = scriptedModel([new Error("connect ECONNRESET")]);
    const result = await generateAnswer(ownerPacket, failing, registry);
    assert.equal(result.source, "deterministic");
    assert.equal(failing.calls, 1);
    const garbage = await generateAnswer(ownerPacket, scriptedModel(["not json"]), registry);
    assert.equal(garbage.source, "deterministic");
  });

  it("returns a public response without prompts, plans, or rejected output", async () => {
    const plan: Plan = {
      status: "plan",
      clarification: null,
      person_mentions: [],
      steps: [{ intent: "owner", project_mention: "proj-atlas", topic: "migration.owner", subject: null, time: { kind: "now", date: null, end_date: null } }],
    };
    const planner: StructuredModel = { id: "planner-test-double", complete: async () => ({ content: JSON.stringify(plan), servedModel: "planner-test-double" }) };
    const invented: Answer = { items: [{ text: "SECRET-REJECTED-TEXT", fact_ids: ["f1"], citation_ids: ["c99"] }] };
    const result = await askQuestion(pool, { question: "Who owns the Atlas migration?", as_of: "2026-10-18T12:00:00-04:00" }, { planner, answerer: scriptedModel([invented]), topics, timezone: TZ });
    const body = toPublicResponse(result);
    assert.deepEqual(Object.keys(body).sort(), ["answer", "as_of", "build_id", "citations", "clarification", "context", "incomplete", "nodes", "notes", "outcome", "paths", "qa_log_id", "question", "timeline"]);
    const text = JSON.stringify(body);
    for (const leak of ["SECRET-REJECTED-TEXT", "You plan how", "You write a short answer", "raw_plan", "prompt"]) assert.ok(!text.includes(leak), `leaked ${leak}`);
    assert.equal(body.answer?.source, "deterministic");
    assert.ok(body.citations.every((citation) => body.answer?.items.some((item) => item.citation_ids.includes(citation.citation_id))));
  });

  it("labels every path endpoint and links answer items to their edges", async () => {
    const timeline: Plan = {
      status: "plan",
      clarification: null,
      person_mentions: [],
      steps: [{ intent: "timeline", project_mention: "proj-atlas", topic: null, subject: null, time: { kind: "all_time", date: null, end_date: null } }],
    };
    const planner: StructuredModel = { id: "planner-test-double", complete: async () => ({ content: JSON.stringify(timeline), servedModel: "planner-test-double" }) };
    const body = toPublicResponse(await askQuestion(pool, { question: "Show the Atlas timeline.", as_of: "2026-10-18T12:00:00-04:00" }, { planner, topics, timezone: TZ }));
    assert.ok(body.paths.length > 10);
    const nodes = new Map(body.nodes.map((node) => [node.id, node]));
    assert.equal(nodes.size, body.nodes.length, "node IDs are unique");
    for (const path of body.paths) assert.ok(nodes.has(path.from) && nodes.has(path.to), `${path.from} -${path.rel}-> ${path.to}`);
    // Every node has a readable label, not its ID.
    for (const node of body.nodes) assert.notEqual(node.label, node.id, `${node.id} (${node.kind}) has no label`);
    assert.equal(nodes.get("dec-atlas-stripe")?.label, "Decided: Stripe");
    assert.equal(nodes.get("prop-atlas-stripe-2026-09-03")?.kind, "proposal");
    assert.equal(nodes.get("p-marcus-lee")?.label, "Marcus Lee");
    assert.deepEqual(body.context, { project: "proj-atlas", topic: null });

    for (const entry of [...(body.answer?.items ?? []), ...body.timeline]) {
      assert.ok(entry.edge_ids.length > 0, entry.text);
      assert.ok(entry.edge_ids.every((index) => body.paths[index] !== undefined));
    }
    // The handoff event highlights Marcus's assignment, not Priya's.
    const handoff = body.timeline.find((event) => /Marcus Lee/.test(event.text) && /migration/.test(event.text));
    const touched = new Set(handoff?.edge_ids.flatMap((index) => [body.paths[index]?.from, body.paths[index]?.to]));
    assert.ok(touched.has("own-atlas-migration-marcus") && !touched.has("own-asg-001"), JSON.stringify(handoff));
  });

  it("returns the resolved project and topic as follow-up context", async () => {
    const plan: Plan = {
      status: "plan",
      clarification: null,
      person_mentions: [],
      steps: [{ intent: "owner", project_mention: "proj-atlas", topic: "migration.owner", subject: null, time: { kind: "now", date: null, end_date: null } }],
    };
    const planner: StructuredModel = { id: "planner-test-double", complete: async () => ({ content: JSON.stringify(plan), servedModel: "planner-test-double" }) };
    const body = toPublicResponse(await askQuestion(pool, { question: "Who owns the Atlas migration?", as_of: "2026-10-18T12:00:00-04:00" }, { planner, topics, timezone: TZ }));
    assert.deepEqual(body.context, { project: "proj-atlas", topic: "migration.owner" });
  });

  it("rejects bad input at the question API before any model call", async () => {
    const { POST } = await import("../../app/api/question/route");
    const post = (body: string) => POST(new Request("http://localhost/api/question", { method: "POST", body, headers: { "content-type": "application/json" } }));
    assert.equal((await post("not json")).status, 400);
    assert.equal((await post(JSON.stringify({ question: "x".repeat(501) }))).status, 400);
    assert.equal((await post(JSON.stringify({ question: "Who?", as_of: "yesterday" }))).status, 400);
  });
});
