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
| Setup, checks, versions, database lifecycle | [docs/dev-environment.md](docs/dev-environment.md) |
| Issue workflow, commits, closing rules | [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md) |
| How skills read domain docs | [docs/agents/domain.md](docs/agents/domain.md) |

## Code map

| Path | Responsibility |
|---|---|
| `app/` | Minimal home page and `/api/health` |
| `src/config/server-env.ts` | Zod-validated server-only configuration |
| `src/db/` | Postgres pool, migration runner, `migrations/*.sql` |
| `src/graph/client.ts` | FalkorDB connection, safe graph names, idempotent index creation |
| `src/smoke/` | Real-service smoke checks (`*.db.ts` holds their SQL) |
| `src/time/` | Company-local times: day/minute precision, timezone, UTC instants |
| `src/contracts/` | Shared Zod contracts (claims, evidence) |
| `src/ingest/` | Manifest, CSV, chunkers, versioning, registry and aliases, fixture loading |
| `src/extract/` | Claim drafts, evidence resolution, validation, claim seeding |
| `src/graph/` | Build snapshot, projection, integrity checks, activation, ownership intervals |
| `src/test-support/` | Isolated `*_test` database for integration tests |
| `fixtures/lumen-freight/` | Synthetic company sources, reviewed claims, independent expected answers |
| `src/provider/openai-transport.ts` | Server-side model-provider transport |
| `scripts/` | Bootstrap/check shell scripts and `tsx` entry points (`data.ts`: registry, ingest, claims; `graph.ts`: rebuild, check, activate, publish) |
