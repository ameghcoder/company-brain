# Context map

Where things are documented. Start with `CLAUDE.md` for working rules.

| Need | Read |
|---|---|
| Domain vocabulary | [GLOSSARY.md](GLOSSARY.md) |
| Agreed product architecture (all milestones) | [docs/architecture.md](docs/architecture.md) |
| Ingestion and graph activation flow (diagram) | [docs/design-flow/ingestion.md](docs/design-flow/ingestion.md) |
| Query and answer flow (diagram) | [docs/design-flow/query.md](docs/design-flow/query.md) |
| Decisions and their reasons | [docs/adr/](docs/adr/) |
| Milestones and parked ideas (`LOC-n`) | [docs/project-plan.md](docs/project-plan.md) |
| Acceptance checks mapped to tests, latest results | [docs/verification.md](docs/verification.md) |
| How AI was used to build and run it | [docs/ai-disclosure.md](docs/ai-disclosure.md) |
| Overview, setup, demo questions (for reviewers) | [README.md](README.md) |
| Setup, checks, versions, database lifecycle | [docs/dev-environment.md](docs/dev-environment.md) |
| Issue workflow, commits, closing rules | [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md) |
| How skills read domain docs | [docs/agents/domain.md](docs/agents/domain.md) |

## Code map

| Path | Responsibility |
|---|---|
| `app/` | One-screen UI (`page.tsx`), `/api/question`, `/api/health` |
| `src/server/` | Question API handler and public-demo limits (size, rate, concurrency, daily budget) |
| `src/components/` | UI client components (question app, React Flow path graph, layout); `ui/` holds shadcn/ui components |
| `src/config/server-env.ts` | Zod-validated server-only configuration |
| `src/db/` | Postgres pool, migration runner, `migrations/*.sql` |
| `src/graph/client.ts` | FalkorDB connection, safe graph names, idempotent index creation |
| `src/smoke/` | Real-service smoke checks (`*.db.ts` holds their SQL) |
| `src/time/` | Company-local times: day/minute precision, timezone, UTC instants |
| `src/contracts/` | Shared Zod contracts (claims, evidence) |
| `src/ingest/` | Manifest, CSV, chunkers, versioning, registry and aliases, fixture loading |
| `src/extract/` | Claim drafts, evidence resolution, validation, seeding; extraction windows, prompt, cache keys, runs, interpretation, linking, approvals, review report |
| `src/embed/` | Embedding cache: embed missing chunk inputs, validate vectors |
| `src/graph/` | Build snapshot, projection, integrity checks, activation, ownership intervals, graph retention (`prune.ts`) |
| `src/graph/queries.ts` | Fixed, parameterised Cypher read templates |
| `src/retrieve/` | Question planning and resolution (`ask.ts`), request pinning, graph tools, hybrid `search_context` (`search.ts`), evidence hydration, alias resolution, `qa_logs` |
| `src/answer/` | Evidence packet, answer prompt and checks, one repair, deterministic fallback, public response and graph node labels; tool-result rendering |
| `src/eval/` | Expected-answer comparison and eval runner (reports in `eval/reports/`, gitignored) |
| `src/test-support/` | Isolated `*_test` database for integration tests |
| `fixtures/lumen-freight/` | Synthetic company sources, reviewed claims, independent expected answers |
| `src/provider/` | Server-side model-provider transport and the (unverified) extraction and embedding adapters |
| `scripts/` | Bootstrap/check shell scripts and `tsx` entry points (`data.ts`: registry, ingest, claims; `graph.ts`: rebuild, check, activate, publish; `eval.ts`; `demo.ts`; `extract.ts`: run, report, apply; `embed.ts`; `ask.ts`; `eval-questions.ts`) |
