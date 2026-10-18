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

**Evidence packet**:
The bounded set of graph facts, paths, conflicts, and hydrated excerpts given to the answer model for one question.

**Effective time**:
When a claim takes effect in the business. Distinct from recorded time, when the source recorded it.

## Graph builds

**Graph build**:
One complete projection of selected document versions and approved claims into a fresh FalkorDB graph.

**Active build**:
The graph build that new questions pin; it changes only after a build passes integrity checks.
