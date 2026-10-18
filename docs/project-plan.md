# Project plan

Local plan for the whole product. `LOC-n` labels are planning handles only: they are **not** GitHub
issue numbers and never appear in commit subjects or branch names. A real GitHub issue is opened
immediately before a milestone's work starts (see [agents/issue-tracker.md](agents/issue-tracker.md)).
Architecture: [architecture.md](architecture.md).

| Label | Milestone | State |
|---|---|---|
| LOC-1 | Bootstrap: scaffold, local Postgres + FalkorDB, connectivity smoke checks | Done (#1, merged); provider access not verified (#2) |
| LOC-2 | Dataset and graph vertical slice | Done on review branch: #4, #5, #6 |
| LOC-3 | Real ingestion and extraction | Provider-independent parts done (#8, #9); real runs blocked on #2 |
| LOC-4 | Natural-language questions and answers | Not started |
| LOC-5 | UI, verification, submission | Not started |

## LOC-1 Bootstrap (done)

Scope and evidence: GitHub issue #1 and [dev-environment.md](dev-environment.md). Open follow-up: model
provider access is **not verified** until a working `OPENAI_AUTH_MODE` configuration exists (GitHub issue #2).

## LOC-2 Dataset and graph vertical slice (done)

Delivered as three issues, each opened just before its work: (1) dataset, schema, and seeding
(#4); (2) fresh-graph build, checks, and activation (#5); (3) fixed graph tools and evaluation against the
expected answers (#6). All 21 expected-answer cases pass. LOC-2 includes the minimal deterministic ingestion the seeded claims need; LOC-3
adds LLM extraction, review reports, and embeddings. Search (`search_context`) waits for embeddings.

- Synthetic company: 2-3 projects, ~8-12 documents/meetings covering a decision replacement, ownership
  transfer, unapproved proposal, ambiguous alias, future-effective change, conflict, and a decision
  without recorded rationale.
- Independent expected answers written before any extractor exists.
- Business schema in Postgres (tables in architecture §4) and seeded reviewed fixture claims.
- `rebuild-graph`, `check-graph`, `activate-graph`: fresh graph per build, integrity checks, pointer flip.
- Fixed graph tools answering the three main questions without an LLM.

## LOC-3 Real ingestion and extraction (current)

The owner chose to build the provider-independent parts while #2 blocks model access: extraction
runs, linking, and review (#8); embedding cache and vector projection (#9). Still to do once
#2 works: run the model over the corpus, review its proposals in the approvals file, publish an
`--claims extracted` build, run `pnpm eval` against it, and `pnpm embed` the chunks. Hybrid
`search_context` (query embeddings at question time) belongs with LOC-4.

- Parsers and chunkers (heading-aware documents, turn-aware meetings, CSV evidence rows), version hashes.
- `extract` with persisted raw output and full cache keys; `review:claims` report plus approvals file.
- `embed` into the embedding cache. Compare extracted facts against the independent expectations.

## LOC-4 Natural-language questions and answers

- Typed planning call, alias resolution and clarification, at most three tool calls.
- Evidence packet, structured answer items, server-side output checks, one capped repair attempt,
  deterministic fallback, outcome codes, `qa_logs`.

## LOC-5 UI, verification, submission

- One screen: question input, answer, vertical timeline, evidence/graph panel (one renderer).
- Request limits, read-only public demo, `eval` report, README, AI-assistant disclosure, recording.
- Deployment gets its own acceptance boundary; nothing is deployed before then.
- Graph retention: prune old build graphs once no pinned request can still use them.

## Ideas parked outside this build

Fuzzy entity resolution, reranking, LLM-generated context headers, semantic chunking, unrestricted chat,
real-time ingestion, multi-agent coordination, multi-tenancy, document-level permissions.
