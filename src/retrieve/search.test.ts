import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fulltextQuery, fuse } from "@/retrieve/search";

describe("search query building", () => {
  it("keeps only plain words, so input cannot alter the full-text query", () => {
    assert.equal(fulltextQuery("@foo:{bar} | -x* ~baz \"quoted\" (paren) %fuzzy%"), "foo bar baz quoted paren fuzzy");
    assert.match(fulltextQuery("'; MATCH (n) DETACH DELETE n //") ?? "", /^[a-z0-9 ]+$/);
  });

  it("drops stopwords, short and repeated terms, and caps the term count", () => {
    assert.equal(fulltextQuery("What was decided about the chargebacks?"), "chargebacks");
    assert.equal(fulltextQuery("CRM crm vendor"), "crm vendor");
    assert.equal(fulltextQuery("a b to of"), null);
    assert.equal(fulltextQuery("one two three four five six seven eight nine ten")?.split(" ").length, 8);
  });
});

describe("reciprocal-rank fusion", () => {
  it("adds ranks across lists and ranks shared hits first", () => {
    const scores = fuse([[{ chunkId: "a" }, { chunkId: "b" }], [{ chunkId: "b" }, { chunkId: "c" }]]);
    assert.equal(scores.get("a"), 1 / 61);
    assert.equal(scores.get("b"), 1 / 62 + 1 / 61);
    assert.equal(scores.get("c"), 1 / 62);
    assert.deepEqual([...scores.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id), ["b", "a", "c"]);
  });
});
