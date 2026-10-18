import { createHash } from "node:crypto";
import { estimateTokens } from "@/ingest/chunk";
import type { TimePoint } from "@/time/company-time";

// Extraction reads bounded windows of a document (whole sections or turn sequences), never
// isolated retrieval chunks, so a decision and its context arrive together.
export const WINDOW_MAX_TOKENS = 3000;

export type WindowDocument = {
  documentId: string;
  versionId: string;
  documentType: string;
  title: string;
  authorId: string | null;
  eventAt: TimePoint;
  projectIds: string[];
  participants: string[];
  chunks: { chunkId: string; body: string; headingPath: string[] }[];
};

export type ExtractionWindow = {
  document: Omit<WindowDocument, "chunks">;
  index: number;
  chunks: WindowDocument["chunks"];
  hash: string;
};

export function buildWindows(document: WindowDocument): ExtractionWindow[] {
  const { chunks, ...meta } = document;
  const groups: WindowDocument["chunks"][] = [];
  let current: WindowDocument["chunks"] = [];
  let tokens = 0;
  for (const chunk of chunks) {
    const size = estimateTokens(chunk.body);
    if (current.length && tokens + size > WINDOW_MAX_TOKENS) {
      groups.push(current);
      current = [];
      tokens = 0;
    }
    current.push(chunk);
    tokens += size;
  }
  if (current.length) groups.push(current);
  return groups.map((group, index) => ({
    document: meta,
    index,
    chunks: group,
    // The version ID already covers document text and metadata; chunk IDs and bodies pin the slice.
    hash: createHash("sha256")
      .update(JSON.stringify([meta.versionId, index, group.map((chunk) => [chunk.chunkId, chunk.body])]))
      .digest("hex"),
  }));
}
