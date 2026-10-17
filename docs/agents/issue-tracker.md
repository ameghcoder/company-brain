# Issue tracker: GitHub

Issues for this repo live in GitHub Issues at `ameghcoder/company-brain`. GitHub Issues plus committed
docs are the durable record; `.temp/` is for transient notes only.

## Tooling

Prefer `gh`. In Claude Code cloud sessions `gh` may be unauthenticated or GraphQL may be blocked; then
use the GitHub MCP tools (`mcp__github__issue_write`, `add_issue_comment`, `issue_read`,
`list_issues`) or the REST API (`POST /repos/{owner}/{repo}/issues`,
`PATCH /repos/{owner}/{repo}/issues/{number}`, `POST /repos/{owner}/{repo}/issues/{number}/comments`)
with structured bodies. Never invent or reserve an issue number; use the number GitHub returns.

- **Create**: `gh issue create --title "..." --body-file <file>`
- **Read**: `gh issue view <number> --json number,title,body,labels,comments`
- **List**: `gh issue list --state open --json number,title,labels`
- **Comment**: `gh issue comment <number> --body-file <file>`
- **Close**: `gh issue close <number> --comment "..."`

## Workflow

1. Open a real issue **immediately before** work starts: problem, scope, acceptance criteria, intended
   checks. Reuse a matching open issue instead of duplicating it. Do not publish whole-product specs or
   a future backlog as issues; future work goes in [../project-plan.md](../project-plan.md) as `LOC-n`.
2. Implement only that issue. A distinct fix outside it gets its own issue first.
3. Run the checks that fit the risk; never report a skipped check as passed.
4. Review the diff and staged files for unintended changes and secrets.
5. Commit as `#NUM type: summary` (under 72 chars; types: feat, fix, chore, docs, refactor, test) with
   at most two short body lines. No closing keywords (`closes #n`, `fixes #n`) in commits or PRs.
6. Push the feature branch with a normal push and confirm the remote branch has the commit.
7. Comment on the issue: commit SHA, branch, checks with actual results, limitations, and commands to
   reproduce.
8. Close the issue only when its acceptance criteria pass and its commits are on the remote branch.
   Blocked items stay open, or the comment separates the done subset from what is blocked.

**Closed means implemented, checked, and pushed on the review branch.** It does not mean merged,
deployed, or production-verified. Deployment has its own acceptance boundary later.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## When a skill says "publish to the issue tracker"

Create a GitHub issue, but only for work that is about to start (see Workflow step 1).

## When a skill says "fetch the relevant ticket"

Read it as in **Read** above.
