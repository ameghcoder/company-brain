import type { EvidenceRef } from "@/contracts/claims";
import type { DraftEvidence } from "@/extract/claim-drafts";

export type EvidenceChunk = { chunkId: string; versionId: string; documentId: string; body: string };

export type EvidenceResolution = { ok: true; evidence: EvidenceRef } | { ok: false; error: string };

// A quote must occur exactly once in the selected version of its document. Several occurrences
// would make the cited span ambiguous, so the reviewer has to quote more context.
export function resolveEvidence(draft: DraftEvidence, chunksOfDocument: EvidenceChunk[]): EvidenceResolution {
  if (!chunksOfDocument.length) return { ok: false, error: `document ${draft.document} has no selected version` };
  const hits: { chunk: EvidenceChunk; start: number }[] = [];
  for (const chunk of chunksOfDocument) {
    for (let at = chunk.body.indexOf(draft.quote); at !== -1; at = chunk.body.indexOf(draft.quote, at + 1)) {
      hits.push({ chunk, start: at });
    }
  }
  const [hit, ...others] = hits;
  if (!hit) return { ok: false, error: `quote not found in ${draft.document}: "${draft.quote}"` };
  if (others.length) {
    return { ok: false, error: `quote occurs ${hits.length} times in ${draft.document}; quote more context: "${draft.quote}"` };
  }
  return {
    ok: true,
    evidence: {
      chunk_id: hit.chunk.chunkId,
      version_id: hit.chunk.versionId,
      document_id: hit.chunk.documentId,
      role: draft.role,
      quote: draft.quote,
      start: hit.start,
      end: hit.start + draft.quote.length,
    },
  };
}
