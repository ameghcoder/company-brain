import type pg from "pg";
import type { EvidenceItem, SourceExcerpt } from "@/contracts/graph-tools";
import { readChunkSources } from "@/retrieve/hydrate.db";

export class EvidenceIntegrityError extends Error {
  override name = "EvidenceIntegrityError";
}

// Collects every evidence item nested anywhere in a tool's facts.
export function collectEvidence(value: unknown, found: EvidenceItem[] = []): EvidenceItem[] {
  if (Array.isArray(value)) {
    for (const item of value) collectEvidence(item, found);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "evidence" && Array.isArray(child)) found.push(...(child as EvidenceItem[]));
      else collectEvidence(child, found);
    }
  }
  return found;
}

export async function hydrateEvidence(pool: pg.Pool, evidence: EvidenceItem[]): Promise<SourceExcerpt[]> {
  const chunkIds = [...new Set(evidence.map((item) => item.chunk_id))].sort();
  if (!chunkIds.length) return [];
  const sources = await readChunkSources(pool, chunkIds);
  const excerpts = new Map<string, SourceExcerpt>();
  const seen = new Set<string>();
  for (const item of evidence) {
    const source = sources.get(item.chunk_id);
    // The graph and the source store must agree exactly; otherwise nothing is cited.
    if (!source || source.versionId !== item.version_id || item.end > source.body.length) {
      throw new EvidenceIntegrityError(`Evidence chunk ${item.chunk_id} is missing or differs in the source store`);
    }
    const key = `${item.claim_id}|${item.chunk_id}|${item.role}|${item.start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const excerpt =
      excerpts.get(item.chunk_id) ??
      ({
        chunk_id: source.chunkId,
        document_id: source.documentId,
        version_id: source.versionId,
        title: source.title,
        event_date: source.eventAt.value,
        heading_path: source.headingPath,
        excerpts: [],
      } satisfies SourceExcerpt);
    excerpt.excerpts.push({ claim_id: item.claim_id, role: item.role, start: item.start, end: item.end, text: source.body.slice(item.start, item.end) });
    excerpts.set(item.chunk_id, excerpt);
  }
  return [...excerpts.values()].sort((a, b) => a.chunk_id.localeCompare(b.chunk_id));
}
