import { parseCsv } from "@/ingest/csv";

// Deterministic chunkers. Markdown and meeting chunk bodies are exact slices of the raw text, so
// evidence offsets stay valid. Bump a chunker version whenever its output could change; chunk IDs
// include it, so old chunks stay immutable.
export const CHUNKER_VERSIONS = {
  markdown: "md-sections-v1",
  meeting: "meeting-turns-v1",
  csv: "csv-rows-v1",
} as const;

// Architecture starting bounds: documents ~400-700 tokens, meetings ~400-600 tokens.
const DOCUMENT_MAX_TOKENS = 700;
const MEETING_MAX_TOKENS = 600;

export type Turn = { speaker: string; at: string; start: number; end: number };

export type ChunkDraft = {
  position: number;
  headingPath: string[];
  body: string;
  // Offsets into the raw document text.
  start: number;
  end: number;
  tokenEstimate: number;
  turns: Turn[];
};

// Rough, model-independent estimate; good enough for bounding chunk size.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

type Span = { start: number; end: number };

function trimSpan(raw: string, span: Span): Span | undefined {
  let { start, end } = span;
  while (start < end && /\s/.test(raw[start] ?? "")) start++;
  while (end > start && /\s/.test(raw[end - 1] ?? "")) end--;
  return start < end ? { start, end } : undefined;
}

function splitSpans(raw: string, span: Span, separator: RegExp): Span[] {
  const text = raw.slice(span.start, span.end);
  const spans: Span[] = [];
  let last = 0;
  for (const match of text.matchAll(separator)) {
    const cut = (match.index ?? 0) + match[0].length;
    spans.push({ start: span.start + last, end: span.start + cut });
    last = cut;
  }
  spans.push({ start: span.start + last, end: span.end });
  return spans.map((part) => trimSpan(raw, part)).filter((part): part is Span => part !== undefined);
}

// Packs consecutive spans into groups whose combined text stays within maxTokens. A single span
// larger than the bound is split at sentence ends first.
function packSpans(raw: string, spans: Span[], maxTokens: number): Span[][] {
  const units = spans.flatMap((span) =>
    estimateTokens(raw.slice(span.start, span.end)) > maxTokens ? splitSpans(raw, span, /[.!?](?=\s)/g) : [span],
  );
  const groups: Span[][] = [];
  let current: Span[] = [];
  for (const unit of units) {
    const first = current[0];
    if (first && estimateTokens(raw.slice(first.start, unit.end)) > maxTokens) {
      groups.push(current);
      current = [];
    }
    current.push(unit);
  }
  if (current.length) groups.push(current);
  return groups;
}

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

export function chunkMarkdown(raw: string): ChunkDraft[] {
  type Section = { headingPath: string[]; span: Span };
  const sections: Section[] = [];
  const stack: { level: number; title: string }[] = [];
  let bodyStart = 0;
  let offset = 0;

  const closeSection = (end: number) => {
    const span = trimSpan(raw, { start: bodyStart, end });
    if (span) sections.push({ headingPath: stack.map((entry) => entry.title), span });
  };

  for (const line of raw.split("\n")) {
    const match = HEADING.exec(line);
    if (match) {
      closeSection(offset);
      const level = (match[1] ?? "#").length;
      while (stack.length && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
      stack.push({ level, title: match[2] ?? "" });
      bodyStart = offset + line.length + 1;
    }
    offset += line.length + 1;
  }
  closeSection(raw.length);

  const drafts: ChunkDraft[] = [];
  for (const section of sections) {
    const paragraphs = splitSpans(raw, section.span, /\n[ \t]*\n/g);
    for (const group of packSpans(raw, paragraphs, DOCUMENT_MAX_TOKENS)) {
      drafts.push(toDraft(raw, drafts.length, section.headingPath, group, []));
    }
  }
  return drafts;
}

const TURN_LINE = /^\[(\d{2}:\d{2})\][ \t]+([^:\n]+):[ \t]*/;

export function chunkMeeting(raw: string): ChunkDraft[] {
  const turns: Turn[] = [];
  let offset = 0;
  for (const line of raw.split("\n")) {
    const match = TURN_LINE.exec(line);
    if (match) {
      turns.push({ speaker: (match[2] ?? "").trim(), at: match[1] ?? "", start: offset, end: offset + line.length });
    } else if (turns.length && line.trim()) {
      // Continuation lines belong to the previous speaker's turn.
      const last = turns[turns.length - 1];
      if (last) last.end = offset + line.length;
    }
    offset += line.length + 1;
  }
  if (!turns.length) throw new Error("Meeting transcript has no '[HH:MM] Speaker: text' turns");

  const drafts: ChunkDraft[] = [];
  for (const group of packSpans(raw, turns, MEETING_MAX_TOKENS)) {
    const groupStart = group[0]?.start ?? 0;
    const groupEnd = group[group.length - 1]?.end ?? 0;
    // Pieces of an oversized turn keep the speaker of the turn they came from.
    const groupTurns = turns
      .filter((turn) => turn.start < groupEnd && turn.end > groupStart)
      .map((turn) => ({ ...turn, start: Math.max(turn.start, groupStart), end: Math.min(turn.end, groupEnd) }));
    drafts.push(toDraft(raw, drafts.length, [], group, groupTurns));
  }
  return drafts;
}

export function chunkCsv(raw: string, title: string): ChunkDraft[] {
  return parseCsv(raw).map((record, index) => {
    const fields = Object.entries(record.values)
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
    const body = `${title}, row ${record.rowNumber}: ${fields}`;
    return {
      position: index,
      headingPath: [title],
      body,
      start: record.start,
      end: record.end,
      tokenEstimate: estimateTokens(body),
      turns: [],
    };
  });
}

function toDraft(raw: string, position: number, headingPath: string[], group: Span[], turns: Turn[]): ChunkDraft {
  const start = group[0]?.start ?? 0;
  const end = group[group.length - 1]?.end ?? start;
  const body = raw.slice(start, end);
  return { position, headingPath, body, start, end, tokenEstimate: estimateTokens(body), turns };
}
