# Extracted claims are re-derived from stored runs and a reviewed approvals file

Extracted claims are not edited in place in Postgres. Every `extract` or `review:apply` re-derives
them from the stored raw model output of the current extraction runs plus a versioned approvals
file (approve, reject, or correct with a note), then writes the result. Claim IDs come from the run
ID (a hash of everything that affects the model output) and the proposal position, so the same runs
always yield the same IDs and the same reviewer decisions.

We chose this over storing review state only in the database because corrections then survive
re-interpretation, the full review history is in version control, and a changed prompt, schema,
model, chunker, or registry visibly produces new claims that need new review instead of silently
inheriting old approvals.

## Consequences

- Claims from runs that are no longer current are retired (`rejected` with a note), never deleted.
- An approval never overrides validation: an approved claim that fails a check is stored as
  `pending` with an "Approval blocked" note.
