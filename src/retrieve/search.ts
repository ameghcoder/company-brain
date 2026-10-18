import type { Graph } from "falkordb";
import type { SearchFacts, SearchHit, SearchRequest, SearchTopic } from "@/contracts/graph-tools";
import type { Embedder } from "@/embed/embed";
import { claimsEvidencedBy, fulltextChunks, nearestChunks, type SearchRow } from "@/graph/queries";
import type { ToolResult } from "@/retrieve/graph-tools";

// search_context: finds which registered topics the records discuss for some words. Measured on
// the real embeddings, vector distance does not separate related from unrelated queries, so a
// topic is a candidate only when a full-text match corroborates it (ADR 0005). Vector hits only
// rank results and appear as related reading.

export const SEARCH_LIMITS = { fulltext: 20, vectorOversample: 20, hits: 8, related: 5 } as const;
const RRF_K = 60;
const STOPWORDS = new Set(["the", "and", "for", "what", "who", "why", "was", "were", "did", "does", "about", "with", "that", "this", "from", "into", "our", "their", "its", "has", "have", "had", "how", "when", "which", "decide", "decided", "decision"]);

// Words only: every RediSearch operator character is dropped, so input cannot alter the query.
// Space-separated terms mean all terms must match.
export function fulltextQuery(text: string): string | null {
  const terms = [...new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((term) => term.length >= 3 && !STOPWORDS.has(term)))];
  return terms.length ? terms.slice(0, 8).join(" ") : null;
}

// Reciprocal-rank fusion: ranks only, so incompatible raw scores are never added together.
export function fuse(lists: { chunkId: string }[][]): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) list.forEach((row, index) => scores.set(row.chunkId, (scores.get(row.chunkId) ?? 0) + 1 / (RRF_K + index + 1)));
  return scores;
}

export type SearchOptions = { embedder: Embedder | null; vectors: { model: string; dimensions: number } | null };

export async function searchContext(graph: Graph, request: SearchRequest, options: SearchOptions): Promise<ToolResult<SearchFacts>> {
  const incomplete: string[] = [];
  const inScope = (row: SearchRow) => !request.project || row.projectIds.includes(request.project);

  const query = fulltextQuery(request.text);
  const lexical = query ? (await fulltextChunks(graph, query, SEARCH_LIMITS.fulltext)).filter(inScope) : [];
  if (!query) incomplete.push("The search text has no searchable words.");

  let semantic: SearchRow[] = [];
  if (!options.vectors) incomplete.push("This build has no vector index; only full-text search ran.");
  else if (!options.embedder || options.embedder.model !== options.vectors.model || options.embedder.dimensions !== options.vectors.dimensions) {
    incomplete.push("No embedder matching this build's vectors is available; only full-text search ran.");
  } else {
    try {
      const [vector] = await options.embedder.embed([request.text]);
      const nearest = await nearestChunks(graph, vector ?? [], SEARCH_LIMITS.vectorOversample);
      semantic = nearest.filter(inScope);
      // Oversample then scope-filter: an empty filtered list is not proof that nothing exists.
      if (request.project && !semantic.length && nearest.length) incomplete.push("Vector neighbours were all outside the project scope.");
    } catch (error) {
      incomplete.push(`Embedding the search text failed (${(error as Error).name}); only full-text search ran.`);
    }
  }

  const scores = fuse([lexical, semantic]);
  const toHit = (row: SearchRow): SearchHit => ({
    chunk_id: row.chunkId,
    document_id: row.documentId,
    title: row.title,
    fulltext_rank: lexical.findIndex((item) => item.chunkId === row.chunkId) + 1 || null,
    vector_rank: semantic.findIndex((item) => item.chunkId === row.chunkId) + 1 || null,
    rrf: Number((scores.get(row.chunkId) ?? 0).toFixed(6)),
  });
  const byScore = (a: SearchHit, b: SearchHit) => b.rrf - a.rrf || a.chunk_id.localeCompare(b.chunk_id);
  const hits = lexical.map(toHit).sort(byScore).slice(0, SEARCH_LIMITS.hits);
  const lexicalIds = new Set(lexical.map((row) => row.chunkId));
  const related = semantic.filter((row) => !lexicalIds.has(row.chunkId)).map(toHit).sort(byScore).slice(0, SEARCH_LIMITS.related);

  const topics = new Map<string, SearchTopic>();
  for (const row of await claimsEvidencedBy(graph, hits.map((hit) => hit.chunk_id))) {
    if (request.project && row.projectId !== request.project) continue;
    const kind = row.kind === "ownership" ? "ownership" : "decision";
    const key = `${row.projectId}/${row.topic}`;
    const topic = topics.get(key) ?? { project_id: row.projectId, topic: row.topic, kind, claim_ids: [], chunk_ids: [], rrf: 0 };
    if (!topic.claim_ids.includes(row.claimId)) topic.claim_ids.push(row.claimId);
    if (!topic.chunk_ids.includes(row.chunkId)) topic.chunk_ids.push(row.chunkId);
    topic.rrf = Math.max(topic.rrf, scores.get(row.chunkId) ?? 0);
    topics.set(key, topic);
  }
  const ranked = [...topics.values()].sort((a, b) => b.rrf - a.rrf || `${a.project_id}/${a.topic}`.localeCompare(`${b.project_id}/${b.topic}`));

  const notes = ranked.length ? [] : [`No recorded decision or ownership mentions "${request.text}".`];
  return {
    outcome: ranked.length ? "answered" : "insufficient_evidence",
    facts: { text: request.text, project: request.project ?? null, hits, related, topics: ranked, incomplete },
    paths: lexical.filter((row) => hits.some((hit) => hit.chunk_id === row.chunkId)).map((row) => ({ from: row.chunkId, rel: "PART_OF", to: row.versionId })),
    notes: [...notes, ...incomplete],
    truncated: lexical.length >= SEARCH_LIMITS.fulltext,
  };
}
