# Project plan

Local plan for the whole product. `LOC-n` labels are planning handles only: they are **not** GitHub
issue numbers and never appear in commit subjects or branch names. A real GitHub issue is opened
immediately before a milestone's work starts (see [agents/issue-tracker.md](agents/issue-tracker.md)).
Architecture: [architecture.md](architecture.md).

| Label | Milestone | State |
|---|---|---|
| LOC-1 | Bootstrap: scaffold, local Postgres + FalkorDB, connectivity smoke checks | Done on review branch, tracked in GitHub issue #1 (provider access not verified) |
| LOC-2 | Dataset and graph vertical slice | Not started |
| LOC-3 | Real ingestion and extraction | Not started |
| LOC-4 | Natural-language questions and answers | Not started |
| LOC-5 | UI, verification, submission | Not started |

## LOC-1 Bootstrap (current)

Scope and evidence: GitHub issue #1 and [dev-environment.md](dev-environment.md). Open follow-up: model
provider access is **not verified** until a working `OPENAI_AUTH_MODE` configuration exists (GitHub issue #2).

## LOC-2 Dataset and graph vertical slice

- Synthetic company: 2-3 projects, ~8-12 documents/meetings covering a decision replacement, ownership
  transfer, unapproved proposal, ambiguous alias, future-effective change, conflict, and a decision
  without recorded rationale.
- Independent expected answers written before any extractor exists.
- Business schema in Postgres (tables in architecture §4) and seeded reviewed fixture claims.
- `rebuild-graph`, `check-graph`, `activate-graph`: fresh graph per build, integrity checks, pointer flip.
- Fixed graph tools answering the three main questions without an LLM.

## LOC-3 Real ingestion and extraction

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

## Ideas parked outside this build

Fuzzy entity resolution, reranking, LLM-generated context headers, semantic chunking, unrestricted chat,
real-time ingestion, multi-agent coordination, multi-tenancy, document-level permissions.
