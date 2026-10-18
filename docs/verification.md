# Verification

Each acceptance check from [architecture §9](architecture.md#9-acceptance-checks), and what covers
it. The **tests** column names `node:test` cases (`pnpm test`); integration tests run against real
Postgres and FalkorDB in a separate `*_test` database. The **eval** column names cases in
`fixtures/lumen-freight/expected/answers.json`: `pnpm eval` runs them as structured requests, and
`pnpm eval:questions` asks them in plain language through the real model.

## Acceptance checks

| Case | Required result | Tests | Eval cases |
|---|---|---|---|
| Same document ingested twice | No duplicate source versions, chunks, or approved events | `ingest/load.test.ts`: "loads the dataset and creates nothing new on a second load", "keeps the old version and selects a new one when a document changes" | — |
| Extraction prompt/schema changes | Explicit re-extraction; old cache not silently reused | `extract/run-extraction.test.ts`: "reuses parsed runs and re-extracts when the prompt version or model changes"; `extract/cache-key.test.ts`: "changes when anything that affects the model output changes" | — |
| Rebuild with provider APIs disabled | Graph created from cached records and vectors | `graph/build.test.ts`: "rebuilds without any network access"; `embed/embed.test.ts`: "projects cached vectors with a vector index and passes the vector checks" | — |
| Correct/remove an approved claim and rebuild | Incorrect relationships absent from the new active graph | `graph/build.test.ts`: "drops relationships of a claim rejected after approval from the next build only" | — |
| New decision replaces earlier one | Same-topic chain and replacement evidence shown | `extract/run-extraction.test.ts`: "keeps proposals as proposals and links replacements and handoffs only within a topic" | `q1-atlas-provider-changes-this-month`, `q2-why-provider-replaced`, `atlas-provider-before-switch`, `q4-atlas-timeline` |
| Similar decision on another topic | No false supersession | `extract/validate-claims.test.ts`: "rejects a supersession across topics" | `atlas-fraud-is-a-separate-topic` |
| A proposal is mentioned | Labelled proposed; does not replace a decided policy | `graph/build.test.ts`: "projects approved claims only, keeping proposals labelled as proposals"; `extract/validate-claims.test.ts`: "rejects a proposal used as a replaced or replacing decision" | `atlas-proposal-is-not-a-decision` |
| Ownership starts in the future | Not returned as current prematurely | `graph/ownership-intervals.test.ts`: "does not end the current holder before a future handoff starts" | `beacon-release-owner-before-future-handoff`, `beacon-release-owner-after-handoff`, `beacon-analytics-future-switch` |
| Historical ownership question | Correct half-open interval selected | `graph/ownership-intervals.test.ts`: "ends the predecessor exactly where an evidenced handoff starts (half-open)"; `retrieve/resolve-plan.test.ts`: "reads 'on D' as the end of D and 'before D' as just before D, across the DST change" | `q3b-migration-owner-before-oct-15`, `q3c-migration-owner-at-handoff-boundary`, `beacon-release-owner-before-records` |
| Two incompatible owner claims | Conflict and both sources returned | `graph/ownership-intervals.test.ts`: "reports overlapping exclusive assignments without a handoff as a conflict"; `answer/check-answer.test.ts`: "reject a conflict stated one-sided, and uncovered main facts" | `cobalt-pipeline-owner-conflict`, `cobalt-pipeline-owner-before-conflict` |
| Ambiguous person or topic | A specific clarification | `retrieve/resolve-plan.test.ts`: "asks which person when a name is ambiguous"; `retrieve/ask.test.ts`: "asks which person when a name is ambiguous, with candidates", "asks which topic when a search matches several" | `alias-alex-is-ambiguous`, `search-migration-topics`, `nl-migration-ambiguous` |
| Documented decision has no rationale | Reason explicitly unknown | `answer/check-answer.test.ts`: "reject a reason or decider the sources do not record" | `cobalt-warehouse-no-rationale` |
| Model returns an invented citation | Reject/repair or verified fallback; no unsupported sentence survives | `answer/check-answer.test.ts`: "reject an invented citation or fact"; `answer/generate.test.ts`: "repairs once, then falls back to the verified rendering", "passes the checks with the deterministic fallback for every expected case" | — |
| Missing subject | Insufficient evidence, not a guess | `retrieve/ask.test.ts`: "reports insufficient evidence when a search finds nothing"; `retrieve/resolve-plan.test.ts`: "reports an unknown project or subject as insufficient evidence" | `q5-absent-subject`, `search-crm-nothing` |
| Build fails validation | Earlier graph remains active | `graph/build.test.ts`: "keeps the earlier build active when a new build fails its checks", "refuses to activate a build that has not been checked" | — |
| Graph unavailable | Explicit unavailable; no Postgres fallback | `retrieve/run-request.test.ts`: "returns unavailable, never a Postgres answer, when the graph cannot be reached"; `retrieve/ask.test.ts`: "returns unavailable when the graph cannot be reached" | — |

Tests that use a model run on **scripted test doubles**. They show that our resolution, checks,
repair cap, and fallback behave as specified. They are not evidence of real planning or answer
quality; `pnpm eval:questions` measures that with the real model.

## Other properties checked

- **Evidence integrity:**
  - `retrieve/run-request.test.ts`: "cites only source text that hydrates to the exact quoted spans";
  - `answer/generate.test.ts`: "quotes each evidence span of a claim, not the first span twice" (regression found in the UI, #16).
- **No leakage to the browser:**
  - `answer/generate.test.ts`: "returns a public response without prompts, plans, or rejected output";
  - the `pnpm check` bundle scan (no connection strings or keys in `.next/static`).
- **Search input safety:** `retrieve/search.test.ts`: "keeps only plain words, so input cannot alter the full-text query"; `retrieve/run-request.test.ts`: "treats search text as words, never as query syntax".
- **Public-demo limits:** `server/question-limits.test.ts`. Refusals happen before any model call (the planner's call count stays unchanged).
- **Graph retention:** `graph/prune.test.ts`. The active build, the rollback build, and graphs named by no build row are never deleted.
- **Expected answers are not vacuous:**
  - `retrieve/run-request.test.ts`: "fails cases whose expectations are wrong, so the comparison is not vacuous";
  - `ingest/expected-answers.test.ts`: expected answers name only known documents and entities, and never claim IDs.

## Latest results

Run on 2026-10-18 on branch `claude/new-session-kdes5y` (the exact commit is in the closing comment
of issue #18).

| Command | Result |
|---|---|
| `pnpm test` | 126/126 pass |
| `pnpm check` | All checks passed: services, tests, typecheck, lint, production build, bundle secret scan, HTTP check |
| `pnpm eval` | 24/24 on build `b20261018t061144_fffe` (fixture claims, with vectors), published from a fresh clone |
| `OPENAI_AUTH_MODE=api_key pnpm eval:questions` | 24/24 with `gpt-5-mini`, planner prompt v3, on the same build |
| Fresh clone of the branch, README steps only | `pnpm bootstrap`, `data:load`, `graph:publish`, `demo`, `eval` (24/24), `check` (126/126 tests) all pass. It shares the running Docker services and database, so it shows the steps work, not a first run on an empty database |
| Paid README steps | `check:provider` passes; `embed` finds nothing missing (cached); `ask` answers with citations |
| Browser run (#16) | The demo questions in Chromium against `pnpm start` with the real provider; screenshots in `docs/screenshots/` |

Planner output varies between runs. While the v3 planner rules were being written (#14), single runs
failed one question each in three different ways, which is what the rules address. Every run
recorded with the committed prompt has passed 24/24 (five runs on 2026-10-18).

## Not verified

- Real LLM extraction over the corpus, and extracted-vs-expected comparison: the path exists and is
  tested with scripted doubles, but no real run was requested.
- Deployment and behaviour behind a real proxy (`TRUST_PROXY=1`): not deployed.
- Load: limits are in memory and per process; no load test was run.
- An automated UI test in `pnpm test`: the browser checks were one-off Playwright runs.
- Person-centric questions: no tool exists; they are refused as unsupported.
