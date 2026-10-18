# Ingestion and graph activation flow

Source of truth for this flow. Read it before changing ingestion, extraction, review, embedding,
projection, or activation code, and update it in the same change. Step details:
[architecture.md §3](../architecture.md#3-ingestion-and-graph-activation-flow).

Status: parse/version/chunk, structured claims, and the reviewed-fixture seed path exist (LOC-2,
`src/ingest/`, `src/extract/`). LLM proposals, review reports, and embeddings are LOC-3; graph build
and activation are the next LOC-2 issue.

```mermaid
flowchart TD
    A["CSV, Markdown, meeting text"] --> B["Parse, version, and chunk"]
    B --> C["Postgres source records"]
    C --> D{"Structured record or prose?"}
    D -->|Structured| E["Deterministic claim proposals"]
    D -->|Prose| F["LLM claim proposals"]
    D -->|"Prose, LOC-2 seed path"| R["Reviewed fixture claims: document + exact quote"]
    E --> G["Resolve IDs and validate evidence"]
    R --> G
    F --> G
    G --> H{"Approval and consistency checks"}
    H -->|Uncertain or conflicting| I["Review, correct, or exclude"]
    I --> G
    H -->|Approved| J["Postgres claims and cached embeddings"]
    J --> K["Build a fresh FalkorDB graph"]
    K --> L{"Integrity and query checks"}
    L -->|Pass| M["Activate completed graph build"]
    L -->|Fail| N["Keep previous build active"]
```

## Invariants

- Document versions and chunks are immutable; re-ingesting identical content creates nothing new.
- Structured CSV rows skip the LLM but still pass schema, identity, date, and consistency validation.
- Reviewed fixture claims are the LOC-2 stand-in for reviewed extraction output. They cite evidence as
  document + exact quote; seeding resolves each quote to exactly one chunk of the selected version.
- Seeding is all-or-nothing: one invalid claim rejects the whole set and nothing is written.
- Only approved claims reach the graph. `review_status` is separate from a decision's business lifecycle.
- `rebuild-graph` makes no LLM or embedding calls; it reads cached records and vectors from Postgres.
- Every build goes into a fresh graph; the active pointer moves only after integrity and query checks pass.
