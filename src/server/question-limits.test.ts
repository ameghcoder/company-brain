import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import type { Plan } from "@/contracts/planning";
import { closePool } from "@/db/pool";
import { DEFAULT_FIXTURE_ROOT, loadFixtures } from "@/ingest/load";
import { loadManifest } from "@/ingest/manifest";
import { readTopicRegistry, type TopicRegistry } from "@/ingest/registry";
import type { StructuredModel } from "@/provider/structured-model";
import { questionHandler } from "@/server/question-handler";
import { QuestionLimiter, type LimitConfig } from "@/server/question-limits";
import { useFreshTestDatabase } from "@/test-support/test-db";

const config = (fields: Partial<LimitConfig> = {}): LimitConfig => ({
  maxBodyBytes: 4096,
  perClient: { limit: 2, windowMs: 60_000 },
  maxConcurrent: 2,
  dailyBudget: 100,
  trustProxy: false,
  ...fields,
});

describe("question limits", () => {
  it("limits each client within a sliding window", () => {
    let now = 1_000_000;
    const limiter = new QuestionLimiter(config(), () => now);
    for (let i = 0; i < 2; i++) {
      const admission = limiter.admit("a");
      assert.ok(admission.ok);
      admission.release();
    }
    const refused = limiter.admit("a");
    assert.ok(!refused.ok && refused.reason === "client_rate" && refused.retryAfterSeconds === 60);
    assert.ok(limiter.admit("b").ok, "other clients are unaffected");
    now += 60_001;
    assert.ok(limiter.admit("a").ok, "the window slides");
  });

  it("caps concurrent questions until one finishes", () => {
    const limiter = new QuestionLimiter(config({ perClient: { limit: 100, windowMs: 60_000 } }));
    const first = limiter.admit("a");
    const second = limiter.admit("b");
    assert.ok(first.ok && second.ok);
    const third = limiter.admit("c");
    assert.ok(!third.ok && third.reason === "concurrency");
    first.release();
    first.release(); // releasing twice frees one slot only
    assert.ok(limiter.admit("c").ok);
    assert.ok(!limiter.admit("d").ok);
  });

  it("stops at the daily budget and resets the next UTC day", () => {
    let now = Date.UTC(2026, 9, 18, 23, 0);
    const limiter = new QuestionLimiter(config({ dailyBudget: 1, perClient: { limit: 100, windowMs: 60_000 } }), () => now);
    const first = limiter.admit("a");
    assert.ok(first.ok);
    first.release();
    const refused = limiter.admit("b");
    assert.ok(!refused.ok && refused.reason === "daily_budget" && refused.retryAfterSeconds === 3600);
    now = Date.UTC(2026, 9, 19, 0, 1);
    assert.ok(limiter.admit("b").ok);
  });

  it("trusts X-Forwarded-For only when configured", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" });
    assert.equal(new QuestionLimiter(config()).clientKey(headers), "shared");
    assert.equal(new QuestionLimiter(config({ trustProxy: true })).clientKey(headers), "ip:203.0.113.7");
    assert.equal(new QuestionLimiter(config({ trustProxy: true })).clientKey(new Headers()), "shared");
  });
});

// SCRIPTED PLANNER DOUBLE: counts calls, so the tests show refusals happen before any model call.
describe("question API limits (real Postgres)", () => {
  let pool: pg.Pool;
  let topics: TopicRegistry;
  const outOfScope: Plan = { status: "out_of_scope", clarification: null, steps: [], person_mentions: [] };
  const planner: StructuredModel & { calls: number } = {
    id: "planner-test-double",
    calls: 0,
    async complete() {
      planner.calls++;
      return { content: JSON.stringify(outOfScope), servedModel: "planner-test-double" };
    },
  };
  const handlerWith = (limits: Partial<LimitConfig>) => {
    const limiter = new QuestionLimiter(config(limits));
    return questionHandler(async () => ({ planner, topics, timezone: "America/New_York" }), () => limiter);
  };
  const post = (handler: ReturnType<typeof questionHandler>, body: string, headers: Record<string, string> = {}) =>
    handler(new Request("http://localhost/api/question", { method: "POST", body, headers: { "content-type": "application/json", ...headers } }));
  const ask = JSON.stringify({ question: "What is the weather?", as_of: "2026-10-18T12:00:00-04:00" });

  before(async () => {
    pool = await useFreshTestDatabase();
    await loadFixtures(pool);
    topics = await readTopicRegistry(await loadManifest(DEFAULT_FIXTURE_ROOT));
  });
  after(async () => {
    await closePool();
  });

  it("answers under the limits and refuses over them before planning", async () => {
    const handler = handlerWith({ perClient: { limit: 1, windowMs: 60_000 } });
    planner.calls = 0;
    assert.equal((await post(handler, ask)).status, 200);
    assert.equal(planner.calls, 1);
    const refused = await post(handler, ask);
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get("retry-after"), "60");
    assert.match(((await refused.json()) as { error: string }).error, /At most 1 question per 1 minutes/);
    assert.equal(planner.calls, 1, "no model call for a refused request");
  });

  it("refuses oversized bodies and spends no budget on invalid input", async () => {
    const handler = handlerWith({ maxBodyBytes: 200, dailyBudget: 1 });
    planner.calls = 0;
    assert.equal((await post(handler, JSON.stringify({ question: "x".repeat(300) }))).status, 413);
    assert.equal((await post(handler, "not json")).status, 400);
    assert.equal((await post(handler, ask)).status, 200, "the one daily question is still available");
    assert.equal((await post(handler, ask)).status, 429);
    assert.equal(planner.calls, 1);
  });

  it("keys clients by X-Forwarded-For only behind a trusted proxy", async () => {
    const spoofable = handlerWith({ perClient: { limit: 1, windowMs: 60_000 } });
    assert.equal((await post(spoofable, ask, { "x-forwarded-for": "198.51.100.1" })).status, 200);
    assert.equal((await post(spoofable, ask, { "x-forwarded-for": "198.51.100.2" })).status, 429, "a forged header does not reset the limit");
    const proxied = handlerWith({ perClient: { limit: 1, windowMs: 60_000 }, trustProxy: true });
    assert.equal((await post(proxied, ask, { "x-forwarded-for": "198.51.100.1" })).status, 200);
    assert.equal((await post(proxied, ask, { "x-forwarded-for": "198.51.100.2" })).status, 200);
  });
});
