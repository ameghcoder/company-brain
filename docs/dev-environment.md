# Development environment

How the Milestone 1 infrastructure is set up, checked, and torn down. This is a **development VM**
setup (Claude Code cloud container or a laptop), not public hosting.

## Tested versions

| Component | Version | Notes |
|---|---|---|
| Node.js | 22.22.0 | `engines.node` is `>=22 <23` |
| pnpm | 10.28.0 | pinned via `packageManager` |
| Next.js | 16.3.8 | App Router, Node runtime; 16.3 line chosen over the days-old 16.4 |
| React | 19.2.9 | |
| TypeScript | 5.9.3 | strict, `noUncheckedIndexedAccess` |
| Zod | 4.6.5 | |
| pg | 8.23.1 | plain driver, no ORM |
| falkordb (npm) | 6.8.0 | |
| tsx | 4.23.15 | runs `scripts/*.ts` |
| Docker / Compose | 29.8.2 / 5.6.0 | |
| PostgreSQL image | `postgres:16.15-alpine` | |
| FalkorDB image | `falkordb/falkordb:v4.20.7` | graph module 42007, Redis 8.10.2; digest `sha256:13996aa523f0dd283f6bd6df6620b094dcea525452417c4d6ef9bef15dc9998d` |

FalkorDB v4.20.7 was verified for: parameterised writes/reads, range indexes,
`db.idx.fulltext.createNodeIndex` / `queryNodes`, and `CREATE VECTOR INDEX ... OPTIONS {dimension,
similarityFunction: 'cosine'}` with `db.idx.vector.queryNodes`. With cosine, the returned `score` is a
**distance** (lower is closer). Creating an index that already exists is an error, so code checks
`db.indexes()` first (`ensureIndex` in `src/graph/client.ts`).

## Commands

| Command | What it does |
|---|---|
| `pnpm bootstrap` (`scripts/dev-bootstrap.sh`) | Starts Docker if needed, ensures images, installs locked deps if the lockfile changed, starts `postgres` + `falkordb` (bounded health wait), applies migrations. Safe to rerun. |
| `pnpm check` (`scripts/dev-check.sh`) | Versions, real-service smoke checks, tests, typecheck, lint, production build, browser-bundle secret scan, HTTP check of the built app. `--quick` skips build and HTTP. |
| `pnpm check:services` | Postgres + FalkorDB smoke checks only. |
| `pnpm test` | Unit tests plus integration tests against the real services. Integration tests reset and use a separate database named `<dev database>_test` (override with `DATABASE_URL_TEST`); development data is never touched. |
| `pnpm data:load` | Seeds the registry, ingests the fixture sources, and seeds reviewed claims in one transaction. Idempotent. Steps also run alone: `pnpm seed:registry`, `pnpm ingest`, `pnpm seed:claims`. |
| `pnpm graph:publish [--claims fixture\|extracted]` | Rebuilds a fresh graph from approved Postgres records, checks it, and activates it only if every check passes. Also separately: `pnpm graph:rebuild`, `pnpm graph:check <buildId>`, `pnpm graph:activate <buildId>`, `pnpm graph:status`. No provider calls. |
| `pnpm eval` | Runs every case in `fixtures/lumen-freight/expected/answers.json` against the active build and writes `eval/reports/eval-<time>.json` (gitignored). Non-zero exit on any failure. |
| `pnpm demo` | Prints deterministic answers, evidence excerpts, and notes for the demo questions. |
| `pnpm extract` | **Paid; not verified (#2).** Calls the model for every window without a `parsed` run (raw output stored before parsing), then stores pending extracted claims and writes a review report to `review/reports/` (gitignored). Needs full provider configuration. |
| `pnpm review:report` | Re-interprets stored runs offline (no calls, no writes) and writes the review report. Needs only `OPENAI_TEXT_MODEL` to select runs. |
| `pnpm review:apply` | Like `review:report`, but applies `fixtures/lumen-freight/review/extracted-approvals.json` and stores the claims. |
| `pnpm embed` | **Paid; not verified (#2).** Embeds selected chunks that have no cached vector for `OPENAI_EMBEDDING_MODEL`/`OPENAI_EMBEDDING_DIMENSIONS`, validating every vector before storing a batch. |
| `pnpm ask "<question>" [--as-of <ISO>] [--json] [--steps]` | **Paid (planning plus answer, at most one repair).** Plans, resolves, runs the fixed tools on the active build, generates a checked answer with citations (or the deterministic fallback), and logs to `qa_logs`. |
| `pnpm eval:questions` | **Paid (a planning and an answer call per question, plus a query embedding when a search runs).** Asks `fixtures/lumen-freight/expected/questions.json` through the real planner and compares with `answers.json`; writes `eval/reports/questions-*.json`. |
| `pnpm db:migrate` | Applies pending `src/db/migrations/*.sql` (advisory-locked, one transaction each). |
| `pnpm check:provider` | **Paid, opt-in.** One tiny completion and one embedding. Also runs inside `pnpm check` when `CHECK_PROVIDER=1`. |
| `pnpm graph:prune [--keep N] [--grace-minutes M] [--dry-run]` | Deletes FalkorDB graphs of builds that are not active, not the kept rollback build(s) (default 1), and retired or unused for longer than the grace period (default 10 min). Rows stay with `pruned_at`. |
| `pnpm dev` / `pnpm build` / `pnpm start` | Next.js on 127.0.0.1. Build and start force `NODE_ENV=production` because the cloud VM exports `NODE_ENV=development`. |
| `pnpm typecheck` / `pnpm lint` | `tsc --noEmit` / ESLint flat config from `eslint-config-next`. |

`POST /api/question` with `{ "question": "...", "as_of"?: "<ISO>", "context"?: {project, topic} }`
returns the public answer shape (outcome, answer items with citation IDs and supporting edge indices,
citations, timeline, paths, labelled graph nodes, follow-up context, incompleteness flags). The server
process needs the provider configuration (`OPENAI_AUTH_MODE=api_key` here). Questions over 500 characters are rejected. Public-demo limits (#17, `src/server/`) refuse a
request with `413` (body over `QUESTION_MAX_BODY_BYTES`) or `429` plus `Retry-After` (per-client rate,
concurrency cap, daily budget) before any model call; see `.env.example` for the settings. Limits are
in memory, so they apply per server process and reset on restart. Clients are told apart by
`X-Forwarded-For` only with `TRUST_PROXY=1`.
Answers take roughly 6-12 s, around 20 s when a repair is needed.

The UI is the home page: `pnpm build && OPENAI_AUTH_MODE=api_key pnpm start`, then open
`http://127.0.0.1:3000`. It calls `/api/question`; the "As of" date is sent as local noon in the
company timezone. shadcn/ui components live in `src/components/ui/` (copied from a pinned commit; see
`SOURCE.md` there, because the shadcn registry host is blocked from this environment).

Bootstrap never runs ingestion, extraction, embeddings, graph rebuilds, or model calls. After a fresh
session or a new database, load the demo data deliberately: `pnpm data:load && pnpm graph:publish`.

Expected `pnpm check:services` output (second and later runs show `exists` and `applied []`):

```
PASS  postgres: connect  server 16.15
PASS  postgres: migrations  applied [], already applied [0001_smoke_checks.sql]
PASS  postgres: write/read, no duplicates  rows for key=1
PASS  postgres: transaction isolation and rollback  inside=true outside=false afterRollback=false
PASS  graph: indexes ensured  exists, exists, exists, exists, exists
PASS  graph: parameterised write/read, no duplicates  {"documents":1,"chunks":3,"decisions":1,"edges":1}
PASS  graph: Decision -EVIDENCED_BY-> Chunk -PART_OF-> Document  [...]
PASS  graph: full-text index query  [{"id":"smoke-chunk-2",...}]
PASS  graph: vector index query (dim 4, cosine)  [{"id":"smoke-chunk-3","score":0.0076},...]
PASS  graph: other graphs untouched  N other graph(s) present before and after
```

The smoke graph is `<FALKORDB_GRAPH_PREFIX>__smoke`. Its 4-dimensional vectors are hand-picked
infrastructure fixtures, not semantic embeddings. Checks never delete graphs and never write outside
the smoke graph and the `smoke_checks` table.

## Configuration

Copy `.env.example` to `.env.local` on a laptop; Next.js reads it. Scripts read the process
environment and default to the local development values below. The Claude Code cloud environment
already exports the same values.

```
DATABASE_URL=postgresql://company_brain:company_brain_dev@127.0.0.1:5432/company_brain
FALKORDB_HOST=127.0.0.1
FALKORDB_PORT=6379
FALKORDB_GRAPH_PREFIX=company_brain
```

These are local synthetic-data credentials, not production defaults. If the app later runs inside
Compose, its hosts become the service names `postgres` and `falkordb` instead of `127.0.0.1`.

### Model provider

`OPENAI_AUTH_MODE` must be the literal `network_secret` or `api_key` (see
[ADR 0003](adr/0003-provider-auth-modes-and-fetch-transport.md)). `OPENAI_TEXT_MODEL`,
`OPENAI_EMBEDDING_MODEL`, and `OPENAI_EMBEDDING_DIMENSIONS` have no defaults. The two embedding
settings also tell graph builds which cached vectors to project (set both or neither); they and are recorded only
after `pnpm check:provider` passes. Network secrets are not available to the environment setup script,
so run provider checks after the session starts.

Verified on 2026-10-18 (#2) in `api_key` mode: `gpt-5-mini` (served as `gpt-5-mini-2025-08-07`) and
`text-embedding-3-small` at 1536 dimensions. `gpt-5-mini` is a reasoning model: hidden reasoning
uses completion tokens, so tiny `max_completion_tokens` caps return empty text; set
`reasoning_effort` and leave headroom. In this cloud environment no network secret is attached for
`api.openai.com`, so commands that call the provider need `OPENAI_AUTH_MODE=api_key` (set it in the
environment settings, or prefix the command). In that mode the key is a plain variable readable by
anything in the VM; a network secret avoids that.

## Database lifecycle

- Data lives in named volumes `company-brain_postgres-data` and `company-brain_falkordb-data`.
  Ports bind to `127.0.0.1` only; the FalkorDB browser UI is disabled.
- `pnpm db:down` stops containers and keeps data. `docker compose down` removes containers and keeps
  volumes. Only `docker compose down -v` deletes the data: do it deliberately.
- Cloud environment snapshots keep files, not running processes. A new or resumed session must
  restart Docker and the services; the SessionStart hook (`.claude/hooks/session-start.sh`, cloud only)
  runs `scripts/dev-bootstrap.sh` with a 300s bound and logs to `.temp/session-start.log`. Never assume
  data from an earlier session's containers exists; rerun bootstrap and the steps that load data.

Each graph build is a separate graph named `<FALKORDB_GRAPH_PREFIX>__build_<buildId>`. Old builds are
kept (they are the record of what each build contained); there is no automatic pruning yet. Tests use
the prefix `company_brain_test` and delete only graphs under it.

## Network dependencies

- npm registry (dependency install), Docker Hub for images. Docker Hub rate-limits anonymous pulls
  from shared egress (HTTP 429); bootstrap then pulls the FalkorDB image from `mirror.gcr.io` and
  accepts it only if its digest matches the pinned Docker Hub digest above.
- `api.openai.com` for provider checks only, through the cloud HTTPS proxy (`NODE_USE_ENV_PROXY=1`).
  Never disable TLS verification.

## Development VM vs public hosting

This setup is for development only: local containers, synthetic data, and credentials kept local.
Public hosting (a later milestone with its own acceptance boundary) needs managed or otherwise durable
databases, `OPENAI_AUTH_MODE=api_key` with a server-only key, request limits, and a read-only demo
surface. Nothing in Milestone 1 is deployed.
