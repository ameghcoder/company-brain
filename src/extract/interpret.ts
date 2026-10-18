import { extractionOutputSchema, type ExtractionOutput, type ProposalEvidence, type UnresolvedMention } from "@/contracts/extraction";
import type { DraftEvidence, ClaimDraft } from "@/extract/claim-drafts";
import type { ExtractionWindow } from "@/extract/windows";

export type ExtractionProblem = { runId: string; documentId: string; claimId?: string; message: string };

// Link requests the model expressed by name; they are resolved against other claims later.
export type LinkHints = { replacesChoice: string | null; takesOverFrom: string | null };

export type InterpretedDraft = { draft: ClaimDraft; hints: LinkHints; citedChunks: Map<string, string>; notes: string[] };

export type InterpretResult = {
  drafts: InterpretedDraft[];
  problems: ExtractionProblem[];
  mentions: (UnresolvedMention & { runId: string; documentId: string })[];
};

export function parseExtractionOutput(raw: string): { ok: true; output: ExtractionOutput } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `not JSON: ${(error as Error).message}` };
  }
  const parsed = extractionOutputSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: `schema mismatch: ${parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}` };
  }
  return { ok: true, output: parsed.data };
}

// Claim IDs derive from the run (whose ID is the cache key) and the proposal's position, so a
// reused run always yields the same IDs and reviewer decisions stay attached to them.
export function extractedClaimId(runId: string, kind: "d" | "o", index: number): string {
  return `x-${runId.slice(2, 14)}-${kind}${index}`;
}

export function interpretRun(runId: string, window: ExtractionWindow, output: ExtractionOutput): InterpretResult {
  const documentId = window.document.documentId;
  const windowChunks = new Set(window.chunks.map((chunk) => chunk.chunkId));
  const problems: ExtractionProblem[] = [];
  const drafts: InterpretedDraft[] = [];
  const documentDate = window.document.eventAt.value;

  const evidenceFor = (claimId: string, items: ProposalEvidence[], proposed: boolean) => {
    const evidence: DraftEvidence[] = [];
    const citedChunks = new Map<string, string>();
    let valid = true;
    for (const item of items) {
      if (!windowChunks.has(item.chunk_id)) {
        problems.push({ runId, documentId, claimId, message: `cites chunk ${item.chunk_id}, which is not in this window` });
        valid = false;
        continue;
      }
      // Evidence that a proposal exists is proposal evidence, whatever the model called it.
      const role = proposed && item.supports === "decision" ? "proposal" : item.supports;
      evidence.push({ document: documentId, role, quote: item.quote });
      citedChunks.set(`${role}|${item.quote}`, item.chunk_id);
    }
    if (!evidence.length) {
      problems.push({ runId, documentId, claimId, message: "has no usable evidence" });
      valid = false;
    }
    return { evidence, citedChunks, valid };
  };

  output.decisions.forEach((proposal, index) => {
    const claimId = extractedClaimId(runId, "d", index);
    const proposed = proposal.status === "proposed";
    const { evidence, citedChunks, valid } = evidenceFor(claimId, proposal.evidence, proposed);
    if (!valid) return;
    const notes: string[] = [];
    if (proposal.uncertainty) notes.push(`model uncertainty: ${proposal.uncertainty}`);
    if (!proposal.decided_on) notes.push(`date taken from the document date ${documentDate}`);
    if (proposed && proposal.replaces_choice) notes.push(`ignored replaces_choice "${proposal.replaces_choice}": a proposal replaces nothing`);
    const when = proposal.decided_on ?? documentDate;
    drafts.push({
      draft: {
        claim_id: claimId,
        kind: "decision",
        origin: "extracted",
        project: proposal.project_id,
        topic: proposal.topic,
        review_status: "pending",
        lifecycle: proposed ? "proposed" : "decided",
        choice: proposal.choice,
        title: proposal.title,
        ...(proposed ? { proposed_at: when } : { decided_at: when, effective_at: proposal.effective_on }),
        rationale: proposal.rationale,
        decided_by: proposal.decided_by,
        evidence,
      },
      hints: { replacesChoice: proposed ? null : proposal.replaces_choice, takesOverFrom: null },
      citedChunks,
      notes,
    });
  });

  output.ownership.forEach((proposal, index) => {
    const claimId = extractedClaimId(runId, "o", index);
    const { evidence, citedChunks, valid } = evidenceFor(claimId, proposal.evidence, false);
    if (!valid) return;
    const notes: string[] = [];
    if (proposal.uncertainty) notes.push(`model uncertainty: ${proposal.uncertainty}`);
    if (!proposal.effective_from) notes.push(`start taken from the document date ${documentDate}`);
    drafts.push({
      draft: {
        claim_id: claimId,
        kind: "ownership",
        origin: "extracted",
        project: proposal.project_id,
        topic: proposal.role,
        review_status: "pending",
        assignee: proposal.assignee_id,
        effective_from: proposal.effective_from ?? documentDate,
        effective_to: proposal.effective_to,
        handoff_from: null,
        evidence,
      },
      hints: { replacesChoice: null, takesOverFrom: proposal.takes_over_from },
      citedChunks,
      notes,
    });
  });

  return { drafts, problems, mentions: output.unresolved_mentions.map((mention) => ({ ...mention, runId, documentId })) };
}
