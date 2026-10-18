# Company Brain

A company decision and ownership assistant. It answers what changed in a project, why a documented
decision was made, who is responsible now or at a given time, and how the history unfolded. Every
substantive answer carries source evidence and the graph paths that supplied its facts. One synthetic
company, batch ingestion, read-only demo. Doc map: [context-map.md](context-map.md).

## Status and scope

- **All milestones (LOC-1 to LOC-5) are done and merged** (last: PR #19). No milestone is
  authorized now: start new work only when the owner asks, and record new ideas in the plan first.
- Outstanding, all the owner's call: the demo recording; deployment (needs explicit approval, plus
  hosting, `TRUST_PROXY`, and a fixed demo "as of" date decision); the two "owner to confirm" points
  in `docs/ai-disclosure.md` and the drafted extraction review decisions (#22); whether the demo
  should switch to the extracted-claims build; the ideas parked in
  [docs/project-plan.md](docs/project-plan.md) (person-centric tool, topic synonyms, latency).
- Keep `docs/verification.md`'s results table current whenever checks change.
- Small tasks inside an authorized milestone don't need separate approval. Stop at the milestone boundary
  and report.
- New ideas go into `docs/project-plan.md` as `LOC-n` items, not into GitHub issues or code.

## Issue, commit, and push workflow

Full rules: [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).

- Open the real GitHub issue **immediately before** work starts; use the number GitHub returns.
  `gh` may not work in cloud sessions: use the GitHub MCP tools or the REST API instead.
- Commit subject: `#NUM type: summary` (under 72 chars), at most two short body lines. No auto-closing
  keywords in commits or PR descriptions.
- Push the current feature branch with a normal push. Never push to or merge into `main`, never
  force-push, never delete branches, never deploy or change repository visibility.
- After the push is confirmed on the remote, comment on the issue (SHA, branch, checks and actual
  results, limitations, reproduce commands). Then close it if its acceptance criteria pass.
- **Closed = implemented, checked, and pushed on the review branch.** Not merged, not deployed.
- Blocked work stays open; say exactly what is outstanding. Never report a skipped check as passed.
- Transient notes go in `.temp/` (gitignored). Durable records are GitHub Issues and committed docs.

## Agent skills

Matt Pocock's engineering skills are installed at project scope in `.claude/skills/` from
`mattpocock/skills` at commit `49dd158d1076134a641b33efb035946536778336` (pinned hashes in
`skills-lock.json`; update with `npx skills@latest update`). Installed: `setup-matt-pocock-skills`,
`to-spec`, `to-tickets`, `tdd`, `diagnosing-bugs`, `code-review`, `domain-modeling`.

The project's `code-review` skill shares a name with Claude Code's built-in code review. The project
copy reviews a diff for standards and spec conformance.

Adaptations for this repo: `to-spec` and `to-tickets` write the plan to `docs/project-plan.md` and
open an issue only for work about to start. Don't publish whole-product specs or backlogs as issues,
and don't re-interview the owner about decisions already recorded in the docs. `triage` is not
installed, so no triage labels exist.

### Issue tracker

GitHub Issues on `ameghcoder/company-brain`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single context: root `GLOSSARY.md` plus `docs/adr/`. See `docs/agents/domain.md`.

## Where things are

- Architecture (all milestones): [docs/architecture.md](docs/architecture.md)
- Flows: [docs/design-flow/ingestion.md](docs/design-flow/ingestion.md),
  [docs/design-flow/query.md](docs/design-flow/query.md). **Read a flow's diagram before changing
  that flow, and update the diagram in the same change.**
- Glossary: [GLOSSARY.md](GLOSSARY.md). ADRs: [docs/adr/](docs/adr/). Setup: [docs/dev-environment.md](docs/dev-environment.md)

## Architecture rules that are easy to break

- **Postgres is the source of record** for sources, versions, chunks, entities, extraction runs,
  reviewed claims, embedding cache, builds, and the active-build pointer.
- **FalkorDB is a replaceable but essential projection.** Business-fact retrieval and traversal happen
  in FalkorDB. Postgres may only resolve aliases and hydrate exact chunk IDs. There is no Postgres
  answer fallback; a graph outage returns `unavailable` ([ADR 0001](docs/adr/0001-postgres-record-falkordb-projection.md)).
- Each build goes into a **fresh graph**, which is activated only after checks pass. Never rebuild
  in place with `MERGE`. `rebuild-graph` makes no model calls. Only `graph:prune` deletes build
  graphs, and only by name from build rows.
- **Fixed, parameterised graph tools only.** No LLM-generated Cypher, and graph names come only from
  `graphName()` ([ADR 0002](docs/adr/0002-fixed-parameterised-graph-tools.md)).
- **Provenance is immutable.** Document versions and chunks are never edited, and approved claim IDs
  are stable. Never expose FalkorDB internal IDs.
- **Reviewed claims.** `review_status` (pending/approved/rejected) is separate from a decision's
  lifecycle. Proposals never become decisions, and confidence scores are not approvals.
- **Evidence must support the specific field asserted.** Unknown rationale stays unknown, and
  conflicts are reported, not resolved by recency.
- **Temporal correctness.** Keep `effective_at` and `recorded_at` distinct. Ownership intervals are
  half-open: `from <= t < to`. Future-effective changes are not current yet.

## Checks (these commands exist and pass)

```bash
pnpm bootstrap        # Docker + services + locked deps + migrations (safe to rerun)
pnpm check            # services smoke, typecheck, lint, build, bundle secret scan, HTTP check
pnpm check --quick    # skip build and HTTP check
pnpm check:services   # Postgres + FalkorDB real-service smoke checks only
pnpm test             # unit tests + integration tests against a separate *_test database
pnpm data:load        # registry + ingest + reviewed claims into the dev database (idempotent)
pnpm graph:publish    # fresh graph build -> integrity checks -> activate only if all pass
pnpm graph:prune      # delete old build graphs (keeps active + 1 rollback; 10 min grace); --dry-run
pnpm eval             # all independent expected-answer cases against the active build (JSON report)
pnpm demo             # the demo questions as structured requests, rendered with evidence
pnpm review:report    # re-interpret stored extraction runs offline -> review/reports/*.md (no writes)
pnpm review:apply     # same, applying fixtures/lumen-freight/review/extracted-approvals.json
pnpm graph:publish --claims extracted   # build from structured + approved extracted claims
pnpm ask "<question>" # PAID: plan + checked answer with citations (needs OPENAI_AUTH_MODE=api_key); --steps shows tool results
pnpm eval:questions   # PAID: hand-written questions through the real planner vs expected answers
pnpm extract          # PAID model calls for windows without a parsed run (v2 runs stored and reviewed, #22)
pnpm embed            # PAID embeddings for chunks missing from the cache (corpus embedded; reruns embed 0)
pnpm build && OPENAI_AUTH_MODE=api_key pnpm start   # the UI at http://127.0.0.1:3000 (PAID per question)
pnpm typecheck && pnpm lint && pnpm build
CHECK_PROVIDER=1 pnpm check   # adds paid minimal provider check (needs valid provider config)
# Provider calls here need OPENAI_AUTH_MODE=api_key (no network secret is attached in this environment).
```

Tests use `node:test` via `tsx` (`src/**/*.test.ts`). Pure logic gets unit tests. Anything touching
Postgres or FalkorDB runs against the real services in the `*_test` database (`useFreshTestDatabase`).
Never mock the databases. Expected answers in `fixtures/lumen-freight/expected/` are written from the
sources by hand and must never be regenerated from claims or graph output.

## Code conventions

- TypeScript strict (plus `noUncheckedIndexedAccess`). Shared Zod contracts go in `src/contracts/` once
  they exist. Validate at boundaries.
- SQL lives beside its owning module in `*.db.ts` files. Shared connection and migrations live in
  `src/db/`, with migrations as numbered SQL files in `src/db/migrations/`.
- **Credentials are server-only.** Read config through `src/config/server-env.ts`. Never use
  `NEXT_PUBLIC_*` for secrets, never print env values, and never echo config values in errors (they may
  be secrets in the wrong variable).
- Model calls go through `src/provider/openai-transport.ts`. Never call providers from build or
  bootstrap. Tests use scripted test doubles for the model (never for databases) and must not be
  presented as evidence of real extraction quality.
- `NODE_ENV=development` is exported in the cloud VM, so `build`/`start` scripts force production.
- Comments are short and explain non-obvious reasons, not what the code says.
- Use shadcn/ui components when the UI needs one. Don't hand-roll an equivalent, and don't add UI
  frameworks speculatively.
- Keep changes scoped and checks proportional to risk. Cut polish and search flexibility before
  evidence integrity or temporal correctness.
