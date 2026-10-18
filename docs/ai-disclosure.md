# AI-assistant disclosure

How AI was used to build Company Brain and where it runs inside it. Statements here are based on the
git history and the committed docs. Items marked **(owner to confirm)** are outside what those records
show.

## Building the project: Claude Code

- **Authorship.** Claude Code (Anthropic), in Claude Code cloud sessions, authored every feature and
  fix commit (`#1` to `#17`): application code, tests, scripts, migrations, and docs. The repository
  owner created the repository, set the milestones and their order, made the decisions recorded in
  the project plan and ADRs when asked (for example, the provider authentication mode, and building
  the provider-independent parts of Milestone 3 first), and merged each milestone's pull request.
- **Synthetic data and expectations.** The Lumen Freight sources, the curated fixture claims
  (`fixtures/lumen-freight/claims/reviewed-claims.json`), the expected answers, and the
  natural-language evaluation questions were written by Claude Code.
  - The expected answers were written from the source documents, never generated from claims or
    graph output.
  - A test forbids them from citing claim IDs.
  - The same assistant wrote both the claims and the expectations, so the two are independent in
    procedure but not in authorship.
- **Architecture.** `docs/architecture.md` was committed by Claude Code in the bootstrap commit as
  the agreed product architecture. Who drafted its content **(owner to confirm)**.
- **Workflow.** Each piece of work has a GitHub issue opened before it started. The closing comment
  on each issue records the commit, the checks run, their actual results, and the limitations.
  Project-scoped engineering skills from `mattpocock/skills` (pinned in `skills-lock.json`) were
  available to the assistant.
- **Review.** Human review of the code beyond merging the milestone pull requests
  **(owner to confirm)**.

## Running the product: OpenAI models

| Model | Used for | Not used for |
|---|---|---|
| `gpt-5-mini` | One planning call per question (intents, names, topic keys, time words); wording the answer from the evidence packet; at most one repair | Choosing graph queries, writing Cypher, resolving names or dates, deciding outcomes |
| `text-embedding-3-small` (1536 dimensions) | Embedding chunks once (cached in Postgres) and the search text when a question names no known topic | Selecting a topic on its own: a full-text match must back it up |

An LLM claim-extraction path exists (`pnpm extract`, with stored raw output and a review file), but no
real extraction run feeds the demo. The demo answers from the curated fixture claims.

## What the server guarantees regardless of the model

- The planner only proposes. Project IDs, topic keys, people, and times are accepted only after the
  server resolves them against the registry; anything else becomes a clarification or
  `insufficient_evidence`.
- Graph access is through fixed, parameterised queries on one pinned, checked build
  ([ADR 0002](adr/0002-fixed-parameterised-graph-tools.md)).
- The answer model sees only a bounded packet of verified facts and numbered citations. The server
  checks every item: each citation must exist and support its facts, and names, choices, and dates
  must come from those facts. Rationale or decider claims are rejected when the sources record none,
  and conflicts must be stated on both sides. After one failed repair, the answer is the verified
  facts stated plainly.
- Prompts, raw plans, and model output that failed checks are never returned to the browser.
- These checks reduce unsupported output; they do not prove entailment.

## Data handling

- The data is synthetic. No real company or personal data is included.
- Each question is logged on the server (`qa_logs`): question, plan, resolved requests, retrieved
  claim IDs, answer, and timings. This is for debugging and evaluation; there is no user account
  or tracking.
- Model calls send the question, the company's project and topic registry, and evidence excerpts to
  the model provider. API keys stay server-side.
