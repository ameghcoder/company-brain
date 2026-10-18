# Company Brain

A company decision and ownership assistant: it answers what changed in a project, why a decision was
made, and who is responsible, with source evidence and graph paths behind every answer. Built for a
hackathon on one synthetic company.

**Status:** Milestones 1-2. Infrastructure plus a graph vertical slice: a synthetic company is
seeded with reviewed, evidenced claims, projected into a checked FalkorDB build, and fixed graph tools
answer the demo questions without an LLM. LLM extraction, natural-language questions, and the UI are
not built yet.

## Quick start (development)

Requires Node 22, pnpm 10, and Docker with Compose.

```bash
pnpm bootstrap   # start Docker services, install locked deps, apply migrations
pnpm check       # real-service smoke checks, typecheck, lint, build, HTTP check
pnpm data:load && pnpm graph:publish   # seed demo data and activate a checked graph build
pnpm demo        # answer the demo questions with evidence
pnpm eval        # compare against the independent expected answers
pnpm dev         # http://127.0.0.1:3000
```

Details: [docs/dev-environment.md](docs/dev-environment.md). Documentation map: [context-map.md](context-map.md).
