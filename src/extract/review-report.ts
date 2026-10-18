import type { Claim } from "@/contracts/claims";
import type { ExtractionSummary } from "@/extract/run-extraction";

// Markdown report for a human reviewer: every run that needs attention, every problem, and every
// extracted claim with its evidence quotes and a ready-to-paste review line.
export function renderReviewReport(summary: ExtractionSummary, generatedAt: Date): string {
  const lines: string[] = [];
  const count = (status: Claim["review_status"]) => summary.claims.filter((claim) => claim.review_status === status).length;
  lines.push("# Extracted claim review", "");
  lines.push(`Generated ${generatedAt.toISOString()}. Extraction config: model \`${summary.config.model}\`, prompt \`${summary.config.promptVersion}\`, schema \`${summary.config.schemaVersion}\`, registry \`${summary.config.registryRevision}\`.`, "");
  lines.push(`- Windows: ${summary.windows} (reused ${summary.reused}, model calls this run ${summary.called})`);
  lines.push(`- Claims: ${summary.claims.length} (pending ${count("pending")}, approved ${count("approved")}, rejected ${count("rejected")})`);
  lines.push(`- Problems: ${summary.problems.length}; unresolved mentions: ${summary.mentions.length}`, "");

  const attention = summary.runs.filter((run) => run.status !== "parsed");
  lines.push("## Runs needing attention", "");
  if (!attention.length) lines.push("None.", "");
  for (const run of attention) lines.push(`- \`${run.documentId}\` window ${run.windowIndex}: **${run.status}**${run.error ? ` (${run.error})` : ""}, attempts ${run.attempts}`);
  if (attention.length) lines.push("");

  lines.push("## Problems (proposals that did not become claims)", "");
  if (!summary.problems.length) lines.push("None.", "");
  for (const problem of summary.problems) lines.push(`- \`${problem.documentId}\`${problem.claimId ? ` ${problem.claimId}` : ""}: ${problem.message}`);
  if (summary.problems.length) lines.push("");

  lines.push("## Unresolved mentions", "");
  if (!summary.mentions.length) lines.push("None.", "");
  for (const mention of summary.mentions) {
    lines.push(`- \`${mention.documentId}\`: "${mention.text}" -> candidates ${mention.candidate_ids.join(", ") || "none"}${mention.note ? ` (${mention.note})` : ""}`);
  }
  if (summary.mentions.length) lines.push("");

  lines.push("## Claims", "");
  for (const claim of [...summary.claims].sort((a, b) => order(a) - order(b) || a.claim_id.localeCompare(b.claim_id))) {
    lines.push(`### ${claim.claim_id} (${claim.kind}, ${claim.review_status})`, "");
    lines.push(`- Scope: \`${claim.project_id}\` / \`${claim.topic}\``);
    for (const line of describe(claim)) lines.push(`- ${line}`);
    if (claim.review_note) lines.push(`- Review note: ${claim.review_note}`);
    for (const message of summary.notes.get(claim.claim_id) ?? []) lines.push(`- Note: ${message}`);
    for (const item of claim.evidence) lines.push(`  > [${item.document_id}] (${item.role}) "${item.quote}"`);
    lines.push("", `Review line: \`{ "claim_id": "${claim.claim_id}", "action": "approve" }\``, "");
  }
  return `${lines.join("\n")}\n`;
}

const order = (claim: Claim) => ({ pending: 0, approved: 1, rejected: 2 })[claim.review_status];

function describe(claim: Claim): string[] {
  switch (claim.kind) {
    case "decision": {
      const p = claim.payload;
      return [
        `${p.lifecycle === "proposed" ? "Proposal" : "Decision"}: **${p.choice}**: ${p.title}`,
        p.lifecycle === "proposed" ? `Proposed: ${p.proposed_at?.value ?? "unknown"}` : `Decided: ${p.decided_at?.value ?? "unknown"}; effective: ${p.effective_at?.value ?? "unknown"} (${p.effective_basis ?? "n/a"})`,
        `Decided by: ${p.decided_by ?? "not stated"}; rationale: ${p.rationale ?? "not stated"}`,
      ];
    }
    case "ownership": {
      const p = claim.payload;
      return [`Assignee: \`${p.assignee_id}\` from ${p.effective_from.value}${p.effective_to ? ` to ${p.effective_to.value}` : ""}`, `Handoff from: ${p.handoff_from ?? "none"}`];
    }
    case "supersession":
      return [`\`${claim.payload.new_decision_id}\` replaces \`${claim.payload.old_decision_id}\` from ${claim.payload.effective_at.value}`];
  }
}
