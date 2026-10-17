# Company Brain architecture

Agreed product architecture for all milestones. Milestone 1 implements only the infrastructure
described in [dev-environment.md](dev-environment.md); everything else here is the roadmap in
[project-plan.md](project-plan.md), not a description of current code. Decisions that need their
reasoning preserved are in [adr/](adr/).

Layout convention: shared Postgres connection, schema, and migrations live in `src/db/`; SQL owned
by a module lives beside it in `*.db.ts` files.

## 1. Product boundary

Build a company decision and ownership assistant. It answers what changed in a project, why a documented decision was made, who is responsible now or at a specified time, and how the history unfolded. Every substantive answer carries source evidence and the graph paths that supplied its facts.

The first version is one synthetic company with several projects. Supported inputs are a roster/project CSV, Markdown project documents, and text meeting notes or transcripts with supplied metadata. Ingestion is a batch command. There are no live Slack, Drive, ticket, or CRM integrations in this submission.

The assistant investigates and explains. External actions such as messaging employees, changing tickets, or editing company records are outside the first version. These are not necessary to demonstrate the Company Brain track.

### Demonstration contract

Use a small, coherent dataset with approximately 8-12 documents/meetings and 2-3 projects. Include a decision replacement, an ownership transfer, an unapproved proposal, an ambiguous alias, a future-effective change, a conflict, and a decision whose rationale was not recorded. Size is a target, not a quality metric.

Example questions:

1. What changed in the Atlas project's payments provider this month?
2. Why did the team replace the earlier provider decision, and where was that decided?
3. Who owns the migration today, and who owned it before October 15?
4. Show the decision and ownership timeline with evidence.
5. What was decided about a subject absent from the dataset?

## 2. Architectural commitments

| Component | Responsibility |
|---|---|
| PostgreSQL | Durable source versions, chunks, entity registry, extraction runs, proposed and approved claims, embedding cache, build manifests, question logs |
| FalkorDB | The application's primary graph database, keyword/vector retrieval, temporal and relationship traversals, evidence paths |
| Next.js with Node runtime | Read-only demo UI and question API |
| TypeScript batch scripts | Parsing, extraction, review, embedding, projection, evaluation |
| LLM | Propose structured claims; select allowed query tools; express retrieved facts in natural language |
| Embedding model | Embed fixed chunk input and user questions using the same configured embedding model |

Postgres is authoritative for stored records and approved extraction decisions. This does not make imported documents or LLM outputs objectively true. Preserve uncertainty, conflicts, and provenance.

FalkorDB is a replaceable projection, but it is essential at query time. Do not implement a parallel Postgres answer path that silently takes over when the graph is unavailable. Postgres may resolve aliases and hydrate source text by exact IDs; FalkorDB must perform business-fact retrieval and traversal.

The app never lets an LLM generate executable Cypher or choose arbitrary graph names. Graph tools are fixed, parameterised functions. The server selects the active build and validates every argument.

## 3. Ingestion and graph activation flow

Diagram: [design-flow/ingestion.md](design-flow/ingestion.md). Update the diagram in the same change as any flow change.

### Step 1: source manifest and entity registry

Each input has a stable source/document ID, source type, title, author where known, event or publication time, timezone, and parser configuration. Meeting metadata supplies speaker identity and turn timestamps where available. Avoid inventing unavailable metadata.

Seed canonical people, teams, projects, and known aliases from CSV. Alias matches are scoped by company and entity type. Multiple matching entities remain ambiguous. For the demo, use a reviewed topic registry per project, such as `payments.provider` and `migration.owner`.

### Step 2: version and chunk

Store immutable document versions with a content hash. Create stable chunk IDs from document-version ID, chunker version, and source position. Keep body text separate from the embedding input.

Documents use heading-aware sections and bounded paragraph/sentence splitting. Retrieval chunks start around 400-700 tokens; respect heading boundaries when practical. Meetings use turn-aware windows around 400-600 tokens. Very long turns and records may be split while retaining speaker identity, timestamps, and offsets. Preserve source spans for multiple speakers within one window.

CSV rows are rendered into readable evidence chunks. Structured records bypass LLM extraction, but must still pass schema, identity, date, and consistency validation.

Use a deterministic embedding header: document title, heading path, and relevant known metadata. Cache the embedding of that complete input. Do not put sensitive or unsupported metadata into the header.

### Step 3: propose claims

Extract prose using bounded section or meeting windows, not isolated retrieval chunks. Supply existing entity IDs and topic keys. Require the model to refer to allowed IDs or mark a mention as unresolved. The output includes supporting chunk IDs, exact supporting spans or excerpts, and explicit uncertainty.

Persist the complete extraction response and configuration before interpreting it. An extraction failure must be visible and retryable. A successful JSON parse is not semantic verification.

Proposals cover decision events, ownership assignments, membership facts when present, and possible relationships between decisions. Proposal language such as “we might switch” must not become an approved business decision.

### Step 4: resolve and review

Resolve exact aliases first. For version one, unresolved or ambiguous references enter a review report; do not implement fuzzy auto-merging. An LLM may suggest a resolution, but it cannot silently merge canonical people or projects.

Validate referenced entities, project/topic scope, dates, and supporting chunks. Confirm quoted spans occur in the source window. Keep `review_status` as `pending`, `approved`, or `rejected`. This is separate from the business decision's state.

For the submission dataset, review prose-derived claims and cross-document replacements through a generated report and a small overrides/approval file. Persist approvals and corrections to Postgres. Deterministic fixture imports still need independent inspection before the demo. Do not represent a model confidence score as a calibrated probability or an approval.

### Step 5: link decision history and derive ownership intervals

Compare a decision only against relevant decisions with the same project and topic. A newer date alone does not prove replacement. A confirmed replacement has a source, an effective time, and the relationship `newer Decision -> SUPERSEDES -> older Decision`.

For this demo, support complete replacement of a topic decision. Partial replacements and complex refinements are marked for review rather than forced into `SUPERSEDES`. Reject self-links and cycles. Permit unresolved branches to remain conflicts rather than inventing one winner.

Ownership assignments are evidence-bearing events. Derive intervals only when an explicit handoff or the dataset's declared exclusive role policy justifies ending the preceding assignment. Missing ownership is unknown. Two incompatible assignments produce a conflict, not an arbitrary last-write winner.

### Step 6: cache embeddings

Store vectors in Postgres as ordinary numeric arrays or JSON suitable for the small dataset; a pgvector index is unnecessary. Cache keys include the full embedding-input hash, model identifier, and dimensions. Validate vector length and finite values before projection.

Extraction cache keys include document/window content hash, parser/chunker configuration, extraction schema version, prompt version, model identifier, and entity/topic registry revision. A content-only cache cannot distinguish a changed extraction policy.

### Step 7: project and activate

Create a fresh graph named for an application-generated build ID. Project selected document versions, approved claims, cached embeddings, stable application IDs, and provenance. Create exact-ID lookup indexes plus chunk vector and full-text indexes. Pin and smoke-test the FalkorDB version used by the implementation.

Do not call an LLM or embedding API from `rebuild-graph`. Do not attempt full reconstruction with `MERGE` alone inside the old graph. Fresh graphs ensure removed or corrected facts do not leave stale relationships behind.

Validate node/edge counts, endpoints, evidence IDs, missing vectors, supersession cycles, ownership conflicts, and required query behavior. Then update the active-build pointer in Postgres in one transaction. A failed build stays inactive; the earlier completed graph remains available.

Every question pins one graph build and its document versions for the whole request. Retain old graphs long enough for pinned requests to finish. A single-process demo may clean up between sessions; a later deployment needs a real retention/in-flight policy.

## 4. Postgres data model

Use typed relational columns for identity, status, and common filters; JSONB for extraction payloads and small evidence structures. Avoid a generic enterprise event framework.

| Table | Main contents |
|---|---|
| `sources` | Origin type and stable origin metadata |
| `documents` | Stable document identity and selected version pointer |
| `document_versions` | Immutable raw text, metadata, hash, source timestamps |
| `chunks` | Version ID, body, headings, source offsets, turn metadata, token count, embedding input/hash |
| `entities` | Stable ID, kind: person/team/project, canonical name |
| `entity_aliases` | Scoped alias-to-entity mappings; ambiguity is preserved |
| `extraction_runs` | Window/configuration hashes, raw output, model/prompt/schema versions, result/errors |
| `claims` | Claim kind, stable ID, entities, project, topic, payload, review state, effective/recorded times, evidence references |
| `embedding_cache` | Input hash, embedding model/dimensions, vector |
| `graph_builds` | Graph name, build state, selected versions/claims, configuration, integrity results |
| `app_state` | Active graph-build ID for this demo company |
| `qa_logs` | Question, build ID, tool plan/arguments, paths, evidence IDs, outcome, answer, timing |

The topic registry and evaluation fixtures may be versioned files. Evaluation runs can write JSON reports instead of introducing an `eval_results` table immediately.

Preserve stable claim IDs after approval. Repeated extraction retries reuse the run identity or create separately identifiable proposals; they must not duplicate accepted business events. Never expose FalkorDB internal node IDs as durable API identifiers.

Document revisions and business history are different. A new revision replaces the selected version of that document; older text is retained for audit and pinned builds. Separately authored meeting records remain distinct documents. A real business change needs a decision or assignment event, not merely a document edit timestamp. This MVP does not reconstruct what the system knew at every historical ingestion time.

## 5. FalkorDB model

Nodes use stable `id` properties. Common `Claim` labels make evidence validation consistent.

| Node | Important fields |
|---|---|
| `Person`, `Team`, `Project` | Canonical ID, name, entity kind |
| `Document` | Immutable version ID, stable document ID, title, source type and event metadata; meetings are documents of type meeting |
| `Chunk` | Chunk ID, body/search text, embedding, version ID, source offsets |
| `Claim:Decision` | Claim ID, project/topic, title, summary, lifecycle, decided/effective times, documented rationale if present |
| `Claim:Ownership` | Claim ID, role/scope, effective interval, recorded time |
| `Claim:Supersession` | Claim ID, effective time, recorded time |

Core relationships:

- `Decision -[:AFFECTS]-> Project`
- `Decision -[:DECIDED_BY]-> Person`, only if explicitly evidenced; absence means unknown
- `Ownership -[:FOR_PROJECT]-> Project`
- `Ownership -[:ASSIGNS_TO]-> Person | Team`
- `Supersession -[:NEW_DECISION]-> Decision`
- `Supersession -[:OLD_DECISION]-> Decision`
- `Decision -[:SUPERSEDES {claim_id, effective_at}]-> Decision`, derived from the approved supersession claim
- `Claim -[:EVIDENCED_BY]-> Chunk`, with evidence roles such as decision, rationale, assignment, or replacement where needed
- `Chunk -[:PART_OF]-> Document`
- `Chunk -[:MENTIONS]-> Person | Team | Project`, for navigation; a mention alone is not evidence that someone owns or decided something

Project/topic keys are stored on claims; a separate `Topic` node is not needed in the first version. Membership can be projected from approved roster facts if useful, but it is not required for the main demo.

Evidence must support the particular field being asserted. A chunk proving that a decision exists does not automatically prove who approved it or why it was made.

### Time rules

- Keep `recorded_at` and `effective_at` distinct. Preserve unknown times and source precision.
- Normalize graph-comparable timestamps to UTC epoch values; retain the original timezone and date precision for display.
- Use explicit date-only handling rather than inventing an exact meeting time.
- Ownership at time `t`: `effective_from <= t AND (effective_to IS NULL OR t < effective_to)`.
- Determine current decisions at the requested time from approved lifecycle and effective supersession events. Do not permanently mark a decision superseded today because a replacement starts next week.
- A pending proposal is not a current accepted decision. A reversed decision need not have a replacement.
- Support valid-time questions such as “who owned it on October 10.” Full bitemporal “what did the assistant know on October 10” behavior is out of scope.

## 6. Query and answer flow

Diagram: [design-flow/query.md](design-flow/query.md). Update the diagram in the same change as any flow change.

The repair step is capped in code at one attempt. A graph or source-store outage returns an explicit unavailable outcome, not a fabricated answer.

### 1. Parse and plan

Use one structured planning call. The plan may contain several supported intents for a compound question, entity mentions, project/topic scope, requested time range, and a proposed set of allowed tool calls. Treat all user and source content as data, not instructions to alter tool permissions.

Resolve aliases with the entity registry. Unknown aliases remain unknown; multiple plausible matches trigger a specific clarification. For “why did Atlas change” without a clear decision/topic, ask which change rather than returning unrelated evidence. A company-wide timeline can span projects when the user explicitly asks for that scope.

### 2. Execute fixed graph tools

| Tool | Behavior |
|---|---|
| `get_changes` | Retrieve effective decision replacements and ownership transfers for scope/time; retain predecessor context outside the window |
| `explain_decision` | Retrieve the selected decision, documented rationale, replacement history where relevant, and supporting sources |
| `get_owner` | Compute current or historical assignment(s), predecessor assignment, evidence, and unresolved conflicts |
| `get_timeline` | Return dated decision, proposal, supersession, and ownership events with explicit state and evidence |
| `search_context` | Hybrid chunk search and bounded neighborhood discovery for finding a referenced decision/topic; not unrestricted general chat |

The controller validates tool names, project IDs, topic keys, times, and limits. No arbitrary writes or generated Cypher. Start with at most three graph-tool calls per question. Further iterations are unnecessary for this fixed problem scope.

An entity match narrows scope; the remaining question still determines which topic/decision matters. For search, use vector plus full-text retrieval and reciprocal-rank fusion. Do not add incompatible raw scores. Escape full-text query syntax separately from Cypher parameterisation.

Vector top-k followed by a scope filter can miss relevant chunks. For the small single-company demo, oversample then scope-filter and expand, with a bound and an explicit incomplete-result signal where appropriate. Do not treat filtered empty top-k as proof that no facts exist. The intent traversals remain the authoritative path for known projects/topics.

### 3. Build an evidence packet

Graph tools return typed facts, supporting claim IDs, source chunk IDs, effective dates, graph paths, and conflicts. Hydrate only those exact chunk IDs/document versions from Postgres. Prioritise complete evidence for the main facts within the context budget.

Pass a compact JSON evidence packet to the answer model: known facts and paths, permitted citation IDs, supporting excerpts, missing fields, conflicts, and any truncation. The answer model does not decide who owns something by rereading arbitrary text if the graph returned a conflict.

Initial configurable bounds: three tool calls, up to eight supersession hops, 50 returned graph nodes, 80 edges, and roughly 6,000 context tokens. Flag a truncated history. These are starting implementation limits and require adjustment after observing the fixture dataset.

### 4. Generate and validate

Produce answer items whose factual fields carry supporting claim/evidence IDs. Only include requested sections. Optional rationale stays unknown when not recorded. Never force a complete `what/why/who` answer from incomplete sources.

Server checks include:

1. All cited chunks were actually included in the final evidence packet.
2. Every supporting claim belongs to this pinned build and supports the returned entity/date/status fields.
3. Returned entity IDs, owner assignments, and timeline values match tool output.
4. Every factual item has evidence; no citation is simply deleted while leaving its statement intact.
5. A conflict or missing fact has not been rewritten as certainty.

Permit one constrained repair attempt. If it fails, return a deterministic rendering of verified tool results, or an insufficient-evidence response. These checks reduce unsupported output; they do not mathematically prove semantic entailment. Independently reviewed evaluation cases remain necessary.

### 5. Return and log

Outcomes: `answered`, `partial`, `needs_clarification`, `conflicting_evidence`, `insufficient_evidence`, or `unavailable`.

Response fields: build ID, outcome, answer items with claim/citation IDs, timeline, sources with quoted spans, returned subgraph paths, and incompleteness flags. Log the question, plan, tool arguments, retrieved IDs, evidence packet membership, final result, and timing. Do not return internal prompts, credentials, or unnecessary raw debug data in the public interface.

## 7. UI and runtime

One screen contains a question input with example prompts, an answer, a timeline, and an evidence/graph panel. Selecting an answer item highlights its supporting path and source excerpt. A simple evidence-first interface is sufficient; graph decoration is not the product.

Use one graph renderer, such as React Flow, for the returned subgraph. Only nodes/edges involved in the answer need to be shown. Use a vertical timeline. No broad graph editor, onboarding flow, billing, or enterprise administration.

The public demo contains only synthetic/public permitted data and is read-only. Ingestion, review, reset, and build activation are CLI-only. Add practical request length/rate limits and server-side API keys to prevent the public demo from exhausting the runtime budget. A future private company deployment would require access control and document-level permissions before real data is connected.

The application needs its own runtime LLM/embedding credentials and database connectivity. Claude Code development credits do not imply that these costs or API permissions are included. Test whether the chosen Claude Code execution environment can run containers or connect to remote databases before delegating the build.

## 8. TypeScript layout and commands

Keep this as one application with scripts, not a collection of services.

| Path | Responsibility |
|---|---|
| `app/` | Page and question endpoint |
| `src/contracts/` | Shared Zod schemas, typed tool contracts, response types |
| `src/db/` | Postgres schema and repository functions |
| `src/ingest/` | Source manifests, parsers, chunking, version hashes |
| `src/extract/` | Structured prompts, proposals, ID resolution, review |
| `src/graph/` | Projection, indexes, build activation, parameterised query templates |
| `src/retrieve/` | Planning, linking, graph tools, hybrid candidate discovery |
| `src/answer/` | Evidence packet, output checks, deterministic fallback |
| `scripts/` | Batch entry points |
| `fixtures/` | Synthetic inputs, approval overrides, independent expected answers |
| `eval/` | Golden-case runner and reports |

Use Next.js, TypeScript, Zod, the `falkordb` client, and the Postgres library already comfortable for the builder. Drizzle is appropriate if scaffolding it does not delay the vertical slice. Avoid adding both an ORM and a second repository abstraction without a concrete need.

Proposed script responsibilities:

- `db:migrate`: create/update the small Postgres schema.
- `seed:registry`: roster, aliases, projects, and topic configuration.
- `ingest`: parse, version, and chunk source inputs.
- `extract`: create/cache structured claim proposals.
- `review:claims`: produce a report and apply explicit approvals/corrections.
- `embed`: populate the embedding cache for selected chunks.
- `rebuild-graph`: construct an inactive graph from approved records only.
- `check-graph`: run structural checks and fixed query checks.
- `activate-graph`: update the active pointer only for a checked build.
- `eval`: run independent expected-result cases and emit a report.

The builder can expose fewer package scripts by combining safe steps, but must preserve the distinction between extraction, projection, and activation.

## 9. Acceptance checks

| Case | Required result |
|---|---|
| Same document ingested twice | No duplicate source versions, chunks, or approved events |
| Extraction prompt/schema changes | Explicit re-extraction occurs or is requested; old cache is not silently reused |
| Rebuild with provider APIs disabled | Successful graph creation from cached records and vectors |
| Correct/remove an approved claim and rebuild | Incorrect relationships are absent from the new active graph |
| New decision replaces earlier one | The same-topic chain and replacement evidence are shown |
| Similar decision on another topic | No false supersession |
| A proposal is mentioned | It is labelled proposed and does not replace a decided policy |
| Ownership starts in the future | It is not returned as the current assignment prematurely |
| Historical ownership question | Correct half-open interval is selected |
| Two incompatible owner claims | Conflict and both sources are returned |
| Ambiguous person or topic | A specific clarification is requested |
| Documented decision has no rationale | Reason is explicitly unknown |
| Model returns an invented citation | Reject/repair or use verified fallback; no unsupported sentence survives |
| Missing subject | Insufficient evidence, not a guessed answer |
| Build fails validation | Earlier graph remains active |
| Graph unavailable | Explicit unavailable response; no silent Postgres chatbot fallback |

Expected answers and critical relationships must be written independently of the extractor. Tests that simply re-read the generated graph as the expected answer will not catch extraction mistakes.

## 10. Implementation order and stop rules

1. **Connectivity smoke test:** Node app can reach Postgres, FalkorDB, and the chosen model endpoints; validate one vector query, one full-text query, and one evidence traversal. Resolve environment problems before generating a large codebase.
2. **Dataset and graph vertical slice:** write independent expected answers and seed reviewed fixture claims; answer the three main questions through fixed graph queries without an LLM.
3. **Real ingestion/extraction:** process the synthetic source documents, review proposals, and compare extracted facts against the independent expectations. Clearly distinguish this path from fixture seeding in the demo.
4. **Natural-language questions and answers:** add typed planning, evidence packets, output validation, logging, and fallback outcomes.
5. **UI, verification, submission:** show answer evidence, graph paths, and timeline; complete README, reproducible setup, AI-assistant disclosure, demo recording, and submission.

If the core vertical slice does not work, cut visual polish and search flexibility first. Do not cut evidence integrity or temporal correctness. Fuzzy entity resolution, reranking, LLM-generated context headers, semantic chunking, unrestricted general chat, real-time ingestion, multi-agent coordination, and production multi-tenancy remain outside this build.
