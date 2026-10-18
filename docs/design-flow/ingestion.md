# Ingestion and graph activation flow

Source of truth for this flow. Read it before changing ingestion, extraction, review, embedding,
projection, or activation code, and update it in the same change. Step details:
[architecture.md §3](../architecture.md#3-ingestion-and-graph-activation-flow).

Status: not implemented yet (planned for LOC-2 and LOC-3 in [project-plan.md](../project-plan.md)).

```mermaid
flowchart TD
    A["CSV, Markdown, meeting text"] --> B["Parse, version, and chunk"]
    B --> C["Postgres source records"]
    C --> D{"Structured record or prose?"}
    D -->|Structured| E["Deterministic claim proposals"]
    D -->|Prose| F["LLM claim proposals"]
    E --> G["Resolve IDs and validate evidence"]
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
- Only approved claims reach the graph. `review_status` is separate from a decision's business lifecycle.
- `rebuild-graph` makes no LLM or embedding calls; it reads cached records and vectors from Postgres.
- Every build goes into a fresh graph; the active pointer moves only after integrity and query checks pass.
