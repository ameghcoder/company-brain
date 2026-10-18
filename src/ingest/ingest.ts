import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type pg from "pg";
import { CHUNKER_VERSIONS, chunkCsv, chunkMarkdown, chunkMeeting, type ChunkDraft } from "@/ingest/chunk";
import { insertChunks, insertVersion, selectVersion, upsertDocument, type ChunkRow } from "@/ingest/ingest.db";
import { resolveInside, type Manifest, type SourceEntry } from "@/ingest/manifest";
import { readEntities, resolveAlias } from "@/ingest/registry.db";
import { parseLocalTime, type TimePoint } from "@/time/company-time";

export type IngestResult = { documents: number; versionsCreated: number; chunksCreated: number; selectionsChanged: number };

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const DOCUMENT_TYPES: Record<SourceEntry["source_type"], SourceEntry["document_type"][]> = {
  csv: ["roster", "projects", "assignments"],
  markdown: ["document"],
  meeting: ["meeting"],
};

// Requires the registry to be seeded first: authors, participants, projects, and meeting speakers
// are checked against known entities.
export async function ingestSources(client: pg.PoolClient, manifest: Manifest): Promise<IngestResult> {
  const entities = new Map((await readEntities(client)).map((entity) => [entity.entityId, entity]));
  const result: IngestResult = { documents: 0, versionsCreated: 0, chunksCreated: 0, selectionsChanged: 0 };

  for (const source of manifest.sources) {
    if (!DOCUMENT_TYPES[source.source_type].includes(source.document_type)) {
      throw new Error(`${source.document_id}: document_type ${source.document_type} does not fit ${source.source_type}`);
    }
    const people = [source.author_id, ...(source.participants ?? [])].filter((id): id is string => Boolean(id));
    for (const id of people) {
      if (entities.get(id)?.kind !== "person") throw new Error(`${source.document_id}: unknown person ${id}`);
    }
    for (const id of source.projects) {
      if (entities.get(id)?.kind !== "project") throw new Error(`${source.document_id}: unknown project ${id}`);
    }

    // Normalise line endings so the same text always hashes the same on every platform.
    const raw = (await readFile(resolveInside(manifest.root, source.path), "utf8")).replace(/\r\n?/g, "\n");
    const eventAt = parseLocalTime(source.event_at, manifest.company.timezone);
    const metadata = {
      source_type: source.source_type,
      document_type: source.document_type,
      title: source.title,
      author_id: source.author_id ?? null,
      event_at: eventAt,
      project_ids: [...source.projects].sort(),
      participants: [...(source.participants ?? [])].sort(),
    };
    const contentHash = sha256(raw);
    // Metadata is part of the version identity: a corrected date or title is a new immutable version.
    const versionId = `${source.document_id}@${sha256(JSON.stringify({ contentHash, metadata })).slice(0, 12)}`;

    await upsertDocument(client, source);
    result.versionsCreated += await insertVersion(client, {
      versionId,
      documentId: source.document_id,
      contentHash,
      rawText: raw,
      title: source.title,
      authorId: source.author_id ?? null,
      eventAt,
      projectIds: metadata.project_ids,
      metadata: { participants: metadata.participants, source_type: source.source_type, path: source.path },
    });

    const chunker = CHUNKER_VERSIONS[source.source_type];
    const drafts = chunkSource(source, raw);
    const projectNames = source.projects.map((id) => entities.get(id)?.canonicalName ?? id);
    const rows: ChunkRow[] = [];
    for (const draft of drafts) {
      // Sequential: one pg client cannot run queries concurrently.
      const turns = [];
      for (const turn of draft.turns) {
        const speaker = await resolveAlias(client, turn.speaker, "person");
        turns.push({ ...turn, speaker_id: speaker.status === "resolved" ? speaker.entityId : null });
      }
      const embeddingInput = embeddingInputFor(source, eventAt, projectNames, draft);
      rows.push({
        chunkId: `${versionId}/${chunker}/${draft.position}`,
        versionId,
        chunkerVersion: chunker,
        draft: { ...draft, turns },
        embeddingInput,
        embeddingInputHash: sha256(embeddingInput),
      });
    }
    result.chunksCreated += await insertChunks(client, rows);
    result.selectionsChanged += await selectVersion(client, source.document_id, versionId);
    result.documents++;
  }
  return result;
}

function chunkSource(source: SourceEntry, raw: string): ChunkDraft[] {
  switch (source.source_type) {
    case "markdown":
      return chunkMarkdown(raw);
    case "meeting":
      return chunkMeeting(raw);
    case "csv":
      return chunkCsv(raw, source.title);
  }
}

// Deterministic header built only from known metadata, so the same chunk always embeds the same way.
function embeddingInputFor(source: SourceEntry, eventAt: TimePoint, projectNames: string[], draft: ChunkDraft): string {
  const header = [
    `Title: ${source.title}`,
    draft.headingPath.length > 1 ? `Section: ${draft.headingPath.slice(1).join(" > ")}` : undefined,
    `Type: ${source.document_type}`,
    `Date: ${eventAt.value}`,
    projectNames.length ? `Projects: ${projectNames.join(", ")}` : undefined,
  ].filter(Boolean);
  return `${header.join("\n")}\n\n${draft.body}`;
}
