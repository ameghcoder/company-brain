import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Answer } from "@/contracts/answer";
import { checkAnswer, datesIn, type NamedEntity } from "@/answer/check-answer";
import type { EvidencePacket, PacketFact } from "@/answer/evidence-packet";
import { deterministicAnswer } from "@/answer/fallback";

const registry: NamedEntity[] = [
  { id: "proj-cobalt", kind: "project", name: "Cobalt", aliases: [] },
  { id: "p-jordan-kim", kind: "person", name: "Jordan Kim", aliases: ["Jordan"] },
  { id: "p-taylor-brooks", kind: "person", name: "Taylor Brooks", aliases: ["Taylor"] },
  { id: "p-dana-ortiz", kind: "person", name: "Dana Ortiz", aliases: ["Dana"] },
  { id: "t-mobile", kind: "team", name: "Mobile", aliases: ["Mobile team"] },
];

const fact = (fields: Partial<PacketFact> & Pick<PacketFact, "fact_id" | "kind" | "summary">): PacketFact => ({
  step: 0,
  entities: [],
  choices: [],
  dates: [],
  citation_ids: [],
  unknown: [],
  conflict_group: null,
  ...fields,
});

const packet: EvidencePacket = {
  question: "q",
  as_of: "2026-10-18T12:00",
  build_id: "b1",
  facts: [
    fact({ fact_id: "f1", kind: "conflicting_owner", summary: "Jordan Kim is recorded as pipeline.owner for Cobalt from 2026-09-20.", entities: [{ id: "proj-cobalt", name: "Cobalt" }, { id: "p-jordan-kim", name: "Jordan Kim" }], dates: ["2026-09-20"], citation_ids: ["c1"], conflict_group: "g" }),
    fact({ fact_id: "f2", kind: "conflicting_owner", summary: "Taylor Brooks is recorded as pipeline.owner for Cobalt from 2026-09-22.", entities: [{ id: "proj-cobalt", name: "Cobalt" }, { id: "p-taylor-brooks", name: "Taylor Brooks" }], dates: ["2026-09-22"], citation_ids: ["c2"], conflict_group: "g" }),
    fact({ fact_id: "f3", kind: "decision", summary: "Snowflake is the decision on warehouse.platform, decided 2026-08-20. No rationale is recorded. Who decided it is not recorded.", entities: [{ id: "proj-cobalt", name: "Cobalt" }], choices: ["Snowflake"], dates: ["2026-08-20"], citation_ids: ["c3"], unknown: ["rationale", "decided_by"] }),
    fact({ fact_id: "f4", kind: "proposal", summary: "BigQuery was proposed on 2026-07-01 but not decided.", choices: ["BigQuery"], dates: ["2026-07-01"], citation_ids: ["c4"] }),
  ],
  citations: ["c1", "c2", "c3", "c4"].map((id) => ({ citation_id: id, claim_id: id, chunk_id: id, document_id: "d", title: "t", role: "decision" as const, excerpt: "e" })),
  missing: [],
  conflicts: ["conflict"],
  truncated: false,
};

const good: Answer = {
  items: [
    { text: "The records conflict: Jordan Kim from September 20 and Taylor Brooks from 2026-09-22 are both recorded for Cobalt.", fact_ids: ["f1", "f2"], citation_ids: ["c1", "c2"] },
    { text: "Cobalt decided on Snowflake on 2026-08-20; the reason and who decided are not recorded.", fact_ids: ["f3"], citation_ids: ["c3"] },
  ],
};

const failuresFor = (answer: Answer) => checkAnswer(answer, packet, registry);
const withItem = (index: number, change: Partial<Answer["items"][number]>): Answer => ({
  items: good.items.map((item, i) => (i === index ? { ...item, ...change } : item)),
});

describe("answer checks", () => {
  it("accept a faithful answer", () => {
    assert.deepEqual(failuresFor(good), []);
  });

  it("reject an invented citation or fact", () => {
    assert.ok(failuresFor(withItem(1, { citation_ids: ["c3", "c99"] })).some((f) => /cites c99, which is not in the packet/.test(f)));
    assert.ok(failuresFor(withItem(1, { fact_ids: ["f3", "f42"] })).some((f) => /fact f42, which is not in the packet/.test(f)));
  });

  it("reject a citation that does not support the item's facts", () => {
    assert.ok(failuresFor(withItem(1, { citation_ids: ["c3", "c4"] })).some((f) => /c4, which does not support/.test(f)));
  });

  it("reject a factual item without citations, and an item with no facts", () => {
    assert.ok(failuresFor(withItem(1, { citation_ids: [] })).some((f) => /without citations/.test(f)));
    assert.ok(failuresFor({ items: [...good.items, { text: "Also, all is well.", fact_ids: [], citation_ids: [] }] }).some((f) => /states no packet fact/.test(f)));
  });

  it("reject names, choices, and dates outside the item's facts", () => {
    assert.ok(failuresFor(withItem(1, { text: "Dana Ortiz chose Snowflake on 2026-08-20; no reason is recorded." })).some((f) => /names Dana Ortiz/.test(f)));
    assert.ok(failuresFor(withItem(1, { text: "Cobalt chose Snowflake over BigQuery on 2026-08-20; reason not recorded." })).some((f) => /mentions BigQuery/.test(f)));
    assert.ok(failuresFor(withItem(1, { text: "Cobalt decided on Snowflake on August 21, 2026; reason not recorded." })).some((f) => /date 2026-08-21/.test(f)));
  });

  it("reject a reason or decider the sources do not record", () => {
    assert.ok(failuresFor(withItem(1, { text: "Cobalt chose Snowflake on 2026-08-20 because it scales." })).some((f) => /rationale is not recorded/.test(f)));
    assert.ok(failuresFor(withItem(1, { text: "Snowflake was approved by the data team on 2026-08-20." })).some((f) => /who decided/.test(f)));
  });

  it("reject a conflict stated one-sided, and uncovered main facts", () => {
    const oneSided: Answer = { items: [{ text: "Jordan Kim owns the Cobalt pipeline since 2026-09-20.", fact_ids: ["f1"], citation_ids: ["c1"] }, good.items[1] as Answer["items"][number]] };
    const failures = failuresFor(oneSided);
    assert.ok(failures.some((f) => /one side of a conflict/.test(f)));
    assert.ok(failures.some((f) => /f2 \(conflicting_owner\) is not covered/.test(f)));
  });

  it("accept the deterministic fallback by construction", () => {
    assert.deepEqual(failuresFor(deterministicAnswer(packet)), []);
  });

  it("read ISO and written dates", () => {
    assert.deepEqual(datesIn("on 2026-10-06, then October 15 and Nov 1st, 2026"), ["2026-10-06", "10-15", "2026-11-01"]);
  });
});
