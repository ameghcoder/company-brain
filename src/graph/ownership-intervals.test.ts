import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OwnershipClaim } from "@/contracts/claims";
import { activeAt, deriveOwnershipIntervals } from "@/graph/ownership-intervals";
import { parseInstant, parseLocalTime } from "@/time/company-time";

const TZ = "America/New_York";
const ms = (instant: string) => parseInstant(instant).getTime();

function assignment(id: string, assignee: string, from: string, options: { to?: string; handoffFrom?: string; role?: string } = {}): OwnershipClaim {
  return {
    claim_id: id,
    kind: "ownership",
    project_id: "proj-a",
    topic: options.role ?? "migration.owner",
    origin: "fixture_reviewed",
    review_status: "approved",
    review_note: null,
    recorded_at: parseLocalTime(from, TZ),
    evidence: [{ chunk_id: "c", version_id: "v", document_id: "d", role: "assignment", quote: "q", start: 0, end: 1 }],
    payload: {
      assignee_id: assignee,
      effective_from: parseLocalTime(from, TZ),
      effective_to: options.to ? parseLocalTime(options.to, TZ) : null,
      handoff_from: options.handoffFrom ?? null,
    },
  };
}

const exclusive = () => true;

describe("ownership intervals", () => {
  it("ends the predecessor exactly where an evidenced handoff starts (half-open)", () => {
    const { intervals, conflicts } = deriveOwnershipIntervals(
      [assignment("own-priya", "p-priya", "2026-09-01"), assignment("own-marcus", "p-marcus", "2026-10-15", { handoffFrom: "own-priya" })],
      exclusive,
    );
    const [priya, marcus] = intervals;
    assert.ok(priya && marcus);
    assert.equal(priya.toMs, ms("2026-10-15T00:00:00-04:00"));
    assert.equal(priya.endReason, "handoff");
    assert.equal(priya.endedBy, "own-marcus");
    assert.deepEqual(conflicts, []);

    const lastMinute = ms("2026-10-14T23:59:00-04:00");
    const boundary = ms("2026-10-15T00:00:00-04:00");
    assert.equal(activeAt(priya, lastMinute), true);
    assert.equal(activeAt(priya, boundary), false);
    assert.equal(activeAt(marcus, boundary), true);
  });

  it("does not end the current holder before a future handoff starts", () => {
    const { intervals } = deriveOwnershipIntervals(
      [assignment("own-lena", "p-lena", "2026-06-01"), assignment("own-sam", "p-sam", "2026-11-01", { handoffFrom: "own-lena" })],
      exclusive,
    );
    const today = ms("2026-10-18T12:00:00-04:00");
    assert.deepEqual(
      intervals.filter((interval) => activeAt(interval, today)).map((interval) => interval.assigneeId),
      ["p-lena"],
    );
  });

  it("reports overlapping exclusive assignments without a handoff as a conflict", () => {
    const { intervals, conflicts } = deriveOwnershipIntervals(
      [assignment("own-jordan", "p-jordan", "2026-09-20"), assignment("own-taylor", "p-taylor", "2026-09-22")],
      exclusive,
    );
    assert.ok(intervals.every((interval) => interval.toMs === null), "no end is invented for either holder");
    assert.deepEqual(conflicts, [
      { projectId: "proj-a", role: "migration.owner", claimIds: ["own-jordan", "own-taylor"], fromMs: ms("2026-09-22T00:00:00-04:00"), toMs: null },
    ]);
  });

  it("allows overlap in non-exclusive roles and across roles", () => {
    const claims = [assignment("own-a", "p-a", "2026-09-01"), assignment("own-b", "p-b", "2026-09-02")];
    assert.deepEqual(deriveOwnershipIntervals(claims, () => false).conflicts, []);
    const otherRole = [assignment("own-a", "p-a", "2026-09-01"), assignment("own-b", "p-b", "2026-09-02", { role: "release.owner" })];
    assert.deepEqual(deriveOwnershipIntervals(otherRole, exclusive).conflicts, []);
  });

  it("keeps a stated end when it comes before any handoff", () => {
    const { intervals, conflicts } = deriveOwnershipIntervals(
      [assignment("own-a", "p-a", "2026-09-01", { to: "2026-09-30" }), assignment("own-b", "p-b", "2026-10-15", { handoffFrom: "own-a" })],
      exclusive,
    );
    assert.equal(intervals[0]?.endReason, "stated");
    assert.equal(intervals[0]?.toMs, ms("2026-09-30T00:00:00-04:00"));
    assert.deepEqual(conflicts, []);
  });
});
