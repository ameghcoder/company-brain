# Company Brain

An assistant that answers what changed in a project, why a decision was made, and who is responsible,
with every substantive answer backed by source evidence and graph paths. One synthetic company.

## Sources

**Source**:
The origin of imported material: a roster CSV, a Markdown document, or a meeting transcript.

**Document**:
A stable identity for one source item; meetings are documents of type meeting.

**Document version**:
An immutable snapshot of a document's text, identified by content hash. A new revision changes the selected version; it is not a business change.
_Avoid_: Revision event

**Chunk**:
A bounded, stable span of a document version used for retrieval and as citable evidence.
_Avoid_: Passage, snippet

## Claims and review

**Claim**:
A structured, evidence-bearing assertion proposed from a source, such as a decision, ownership assignment, or supersession.
_Avoid_: Fact (until approved), extraction

**Structured claim**:
A claim derived deterministically from a structured record, such as a row of the assignments CSV.

**Reviewed fixture claim**:
A hand-reviewed claim in the fixture set that cites its evidence as a document and an exact quote; the stand-in for reviewed extraction output until extraction exists.

**Extraction run**:
One model call for one document window under one cache key, with its raw output stored before interpretation.
_Avoid_: Job, request

**Window**:
A bounded, contiguous span of a document version's chunks sent to the model together.

**Claim set**:
Which reviewed claims a graph build projects: `fixture` (structured plus fixture-reviewed) or `extracted` (structured plus extracted).

**Review status**:
Whether a claim is `pending`, `approved`, or `rejected` for use in the graph. Independent of a decision's lifecycle.

**Decision**:
A claim that a project adopted a choice on a topic, with decided and effective times and rationale only if documented.

**Proposal**:
A decision under discussion but not adopted; it never counts as a current decision.
_Avoid_: Tentative decision

**Supersession**:
An approved claim that a newer decision fully replaces an older decision on the same project and topic, from an effective time.
_Avoid_: Override, update

**Ownership assignment**:
A claim that a person or team holds a role for a project scope over a half-open effective interval.
_Avoid_: Owner field

**Handoff**:
Explicit evidence that one ownership assignment replaces an earlier one for the same project and role; the only way an assignment gets an end date it does not state itself.
_Avoid_: Reassignment (when no handoff is evidenced)

**Exclusive role**:
A project role that one person or team holds at a time, so overlapping assignments without a handoff are a conflict.

**Choice**:
What a decision or proposal selects for its topic, such as "Stripe" for `payments.provider`.

**Conflict**:
Two approved claims that cannot both hold; reported with both sources rather than resolved by recency.

**Topic**:
A reviewed, project-scoped key naming what a decision or ownership concerns, such as `payments.provider`.

**Alias**:
An alternative name for a person, team, or project, scoped by company and entity kind; may be ambiguous.

## Evidence and time

**Evidence**:
The chunk or chunks supporting a specific field of a claim, with a role such as decision, rationale, assignment, or replacement.
_Avoid_: Source (when meaning a chunk), citation (when meaning the stored link)

**Plan**:
The planning model's proposal for one question: intents, mentions, topic keys, and time words. Never trusted until the server resolves it.

**Clarification**:
A specific question back to the user when a name, topic, or project fits several recorded entities; never a guess.

**Topic search**:
`search_context`: finds which registered topic a subject means when the question names none. A topic counts only if a full-text match supports it; vector-only hits are **related reading**, never a match.

**Evidence packet**:
The bounded set of graph facts, paths, conflicts, and hydrated excerpts given to the answer model for one question.

**Answer item**:
One or two sentences of a generated answer, with the packet facts it states and the citations supporting them.

**Deterministic answer**:
The fallback answer: each packet fact stated in its own verified words with its own citations.
_Avoid_: Template answer

**Effective time**:
When a claim takes effect in the business. Distinct from recorded time, when the source recorded it.

## Graph builds

**Graph build**:
One complete projection of selected document versions and approved claims into a fresh FalkorDB graph.

**Active build**:
The graph build that new questions pin; it changes only after a build passes integrity checks.

**Retired build**:
A build that was active and has been replaced; its graph is kept until `graph:prune` removes it after a grace period, except the most recent one, kept for rollback.
_Avoid_: Old build
