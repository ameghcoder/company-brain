import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { localDateString, parseInstant, parseLocalTime, startOfLocalDay } from "@/time/company-time";

const NY = "America/New_York";

describe("company time", () => {
  it("maps a day-precision date to the start of that local day", () => {
    assert.deepEqual(parseLocalTime("2026-10-15", NY), {
      value: "2026-10-15",
      precision: "day",
      timezone: NY,
      utc: "2026-10-15T04:00:00.000Z",
    });
  });

  it("uses the winter offset after daylight saving ends", () => {
    assert.equal(parseLocalTime("2026-11-02", NY).utc, "2026-11-02T05:00:00.000Z");
    // 2026-11-01 starts in EDT; the clocks fall back at 02:00 local that day.
    assert.equal(parseLocalTime("2026-11-01", NY).utc, "2026-11-01T04:00:00.000Z");
  });

  it("keeps minute precision for meeting times", () => {
    const point = parseLocalTime("2026-10-02T14:08", NY);
    assert.equal(point.precision, "minute");
    assert.equal(point.utc, "2026-10-02T18:08:00.000Z");
  });

  it("rejects malformed and impossible dates", () => {
    assert.throws(() => parseLocalTime("2026-02-30", NY), /Invalid calendar time/);
    assert.throws(() => parseLocalTime("Oct 15", NY), /Expected YYYY-MM-DD/);
  });

  it("requires instants to carry an explicit offset", () => {
    assert.equal(parseInstant("2026-10-18T12:00:00-04:00").toISOString(), "2026-10-18T16:00:00.000Z");
    assert.throws(() => parseInstant("2026-10-18T12:00:00"), /explicit|offset/);
  });

  it("finds the local calendar day of an instant", () => {
    const lateEvening = parseInstant("2026-10-15T02:30:00Z"); // 22:30 on Oct 14 in New York
    assert.equal(localDateString(lateEvening, NY), "2026-10-14");
    assert.equal(startOfLocalDay(lateEvening, NY).toISOString(), "2026-10-14T04:00:00.000Z");
  });
});
