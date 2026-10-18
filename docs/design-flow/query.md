# Query and answer flow

Source of truth for this flow. Read it before changing planning, graph tools, evidence packets,
answer validation, or response shape, and update it in the same change. Step details:
[architecture.md §6](../architecture.md#6-query-and-answer-flow).

Status: pinning, the fixed tools, hydration, and deterministic rendering (LOC-2), plus
natural-language planning, deterministic resolution, multi-step execution on one pinned build, and
`qa_logs` (LOC-4, #12: `src/retrieve/ask.ts`, `resolve-plan.ts`, `plan-prompt.ts`), and the
evidence packet, generated answers, server checks, one repair, deterministic fallback, and
`POST /api/question` (#13: `src/answer/`). `search_context` follows.

```mermaid
flowchart TD
    A["User question"] --> B["Pin active graph build"]
    B --> C["One planning call proposes intents, mentions, topic keys, and time words"]
    C --> RS["Server resolves names, keys, and times against the registry"]
    RS --> D{"Unambiguous request?"}
    D -->|No| E["Ask a specific clarification"]
    D -->|Yes| F["Execute allowed FalkorDB tools"]
    F --> G["Facts, paths, conflicts, and evidence IDs"]
    G --> H["Hydrate exact source chunks from Postgres"]
    H --> I["Assemble bounded evidence packet"]
    I --> J["Generate structured answer items"]
    J --> K{"Evidence and output checks pass?"}
    K -->|Yes| L["Answer, timeline, paths, and sources"]
    K -->|No| M{"Repair already used?"}
    M -->|No| R["One constrained repair attempt"]
    R --> K
    M -->|Yes| N["Return verified facts or insufficient evidence"]
```

## Invariants

- One graph build is pinned for the whole request.
- Business facts come from fixed, parameterised FalkorDB tools; Postgres only resolves aliases and
  hydrates exact chunk IDs. There is no Postgres answer path when the graph is unavailable.
- Tool inputs are validated before any query runs; the server picks the build and graph name.
- The planner only proposes. Project IDs, topic keys, and times are accepted only after the server
  resolves them against the registry; an ambiguous person or project yields a clarification with
  candidates, an unknown subject yields `insufficient_evidence`, and an invalid plan answers nothing.
- "On D" means the state at the end of D; "before D" means just before D starts (company timezone).
- At most three steps run; extra steps are dropped and the outcome is `partial`.
- "Current at t" and "active at t" are evaluated inside the graph queries: a decision is current if
  decided, effective by t, and not replaced by a replacement effective by t; ownership uses
  `from <= t < to`.
- Excerpts are sliced from Postgres chunk text by the spans on EVIDENCED_BY edges; a mismatch between
  the graph and the source store fails the request as `unavailable` instead of citing anything.
- The repair step runs at most once (`MAX_REPAIRS` in `src/answer/generate.ts`); a provider error is
  not repaired. Failing that, the answer is the deterministic rendering of packet facts, which
  passes the checks by construction.
- The answer model sees only the evidence packet: deterministic facts (each with its own summary,
  entities, choices, dates, citations, unknown fields, conflict group) and numbered citations.
- Checks: cited facts/citations exist; citations support the item's facts; names, choices, and
  dates in an item come from its facts; factual items cite evidence; all main facts covered; no
  one-sided conflict; no asserted rationale or decider the sources lack. They reduce unsupported
  output; they do not prove entailment.
- The public response never includes prompts, raw plans, or model output that failed checks.
- Outcomes: `answered`, `partial`, `needs_clarification`, `conflicting_evidence`,
  `insufficient_evidence`, `unavailable`.
