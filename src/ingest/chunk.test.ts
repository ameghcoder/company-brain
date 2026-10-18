import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chunkCsv, chunkMarkdown, chunkMeeting } from "@/ingest/chunk";
import { parseCsv } from "@/ingest/csv";

describe("markdown chunker", () => {
  const raw = "# Title\n\nStatus: Accepted\n\n## Decision\n\nUse Stripe.\n\n### Detail\n\nEffective soon.\n\n## Empty\n\n";

  it("emits one chunk per non-empty section with its heading path", () => {
    const chunks = chunkMarkdown(raw);
    assert.deepEqual(
      chunks.map((chunk) => [chunk.headingPath, chunk.body]),
      [
        [["Title"], "Status: Accepted"],
        [["Title", "Decision"], "Use Stripe."],
        [["Title", "Decision", "Detail"], "Effective soon."],
      ],
    );
  });

  it("keeps bodies as exact slices of the raw text", () => {
    for (const chunk of chunkMarkdown(raw)) assert.equal(raw.slice(chunk.start, chunk.end), chunk.body);
  });

  it("splits an oversized section at paragraph boundaries", () => {
    const paragraph = "word ".repeat(300).trim();
    const big = `# Long\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}\n`;
    const chunks = chunkMarkdown(big);
    assert.ok(chunks.length >= 2);
    for (const chunk of chunks) {
      assert.ok(chunk.tokenEstimate <= 700, `chunk has ${chunk.tokenEstimate} tokens`);
      assert.equal(big.slice(chunk.start, chunk.end), chunk.body);
    }
  });
});

describe("meeting chunker", () => {
  const raw = "[10:00] Priya Raman: Hello.\n[10:02] Alex Chen: We might switch.\ncontinued thought.\n";

  it("records each speaker turn with time and offsets", () => {
    const [chunk, ...rest] = chunkMeeting(raw);
    assert.equal(rest.length, 0);
    assert.ok(chunk);
    assert.equal(chunk.body, raw.trimEnd());
    assert.deepEqual(
      chunk.turns.map((turn) => [turn.speaker, turn.at, raw.slice(turn.start, turn.end)]),
      [
        ["Priya Raman", "10:00", "[10:00] Priya Raman: Hello."],
        ["Alex Chen", "10:02", "[10:02] Alex Chen: We might switch.\ncontinued thought."],
      ],
    );
  });

  it("windows long meetings and keeps speakers on split turns", () => {
    const longTurn = `[11:00] Dana Ortiz: ${"This is a sentence. ".repeat(200)}`;
    const chunks = chunkMeeting(`${longTurn}\n[11:30] Sam Okafor: Done.\n`);
    assert.ok(chunks.length >= 2);
    for (const chunk of chunks) {
      assert.ok(chunk.tokenEstimate <= 600);
      assert.ok(chunk.turns.length >= 1);
    }
    assert.equal(chunks[0]?.turns[0]?.speaker, "Dana Ortiz");
  });

  it("rejects text without turns", () => {
    assert.throws(() => chunkMeeting("just notes"), /no '\[HH:MM\] Speaker: text' turns/);
  });
});

describe("csv", () => {
  it("parses quoted fields and keeps row spans", () => {
    const raw = 'id,name,note\na,"Lee, Marcus","said ""hi"""\n';
    const [record] = parseCsv(raw);
    assert.deepEqual(record?.values, { id: "a", name: "Lee, Marcus", note: 'said "hi"' });
    assert.equal(raw.slice(record?.start, record?.end), 'a,"Lee, Marcus","said ""hi"""');
  });

  it("renders one readable chunk per row", () => {
    const [chunk] = chunkCsv("id,role\nasg-1,migration.owner\n", "Assignments");
    assert.equal(chunk?.body, "Assignments, row 1: id=asg-1; role=migration.owner");
  });

  it("rejects rows with the wrong field count", () => {
    assert.throws(() => parseCsv("a,b\n1\n"), /expected 2/);
  });
});
