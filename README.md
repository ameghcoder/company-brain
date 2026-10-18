# Company Brain

A company decision and ownership assistant: it answers what changed in a project, why a decision was
made, and who is responsible, with source evidence and graph paths behind every answer. Built for a
hackathon on one synthetic company.

**Status:** Milestone 1 (infrastructure) only. The scaffold, local Postgres + FalkorDB, and
connectivity checks work; ingestion, question answering, and the real UI are not built yet.

## Quick start (development)

Requires Node 22, pnpm 10, and Docker with Compose.

```bash
pnpm bootstrap   # start Docker services, install locked deps, apply migrations
pnpm check       # real-service smoke checks, typecheck, lint, build, HTTP check
pnpm dev         # http://127.0.0.1:3000
```

Details: [docs/dev-environment.md](docs/dev-environment.md). Documentation map: [context-map.md](context-map.md).
