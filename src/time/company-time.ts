import { z } from "zod";

// Source times are written in the company's local time with either day or minute precision.
// We keep what the source said (value, precision, timezone) and a UTC instant for comparisons.
// A day-precision value maps to the start of that local day, never to an invented clock time.

export const timePointSchema = z.object({
  value: z.string(),
  precision: z.enum(["day", "minute"]),
  timezone: z.string(),
  utc: z.string(),
});
export type TimePoint = z.infer<typeof timePointSchema>;

const LOCAL_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_MINUTE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
// Instants must carry an explicit offset so they never depend on the machine's timezone.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export function parseLocalTime(value: string, timezone: string): TimePoint {
  const day = LOCAL_DAY.exec(value);
  const minute = LOCAL_MINUTE.exec(value);
  const parts = day ?? minute;
  if (!parts) throw new Error(`Expected YYYY-MM-DD or YYYY-MM-DDTHH:MM, got "${value}"`);
  const [y, m, d, hh = "0", mm = "0"] = parts.slice(1).map((part) => part ?? "0");
  const local = { year: Number(y), month: Number(m), day: Number(d), hour: Number(hh), minute: Number(mm) };
  assertValidLocal(local, value);
  return {
    value,
    precision: day ? "day" : "minute",
    timezone,
    utc: zonedLocalToUtc(local, timezone).toISOString(),
  };
}

export function parseInstant(value: string): Date {
  if (!INSTANT.test(value)) throw new Error(`Expected an ISO instant with offset, got "${value}"`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid instant "${value}"`);
  return date;
}

export function startOfLocalDay(date: Date, timezone: string): Date {
  const local = utcToZonedLocal(date, timezone);
  return zonedLocalToUtc({ ...local, hour: 0, minute: 0 }, timezone);
}

export function localDateString(date: Date, timezone: string): string {
  const { year, month, day } = utcToZonedLocal(date, timezone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// The local wall-clock minute of an instant, e.g. for telling a model what "now" is.
export function toLocalTimePoint(date: Date, timezone: string): TimePoint {
  const { year, month, day, hour, minute } = utcToZonedLocal(date, timezone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return { value: `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`, precision: "minute", timezone, utc: date.toISOString() };
}

type LocalFields = { year: number; month: number; day: number; hour: number; minute: number };

function assertValidLocal(local: LocalFields, value: string): void {
  const probe = new Date(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute));
  if (
    probe.getUTCFullYear() !== local.year ||
    probe.getUTCMonth() !== local.month - 1 ||
    probe.getUTCDate() !== local.day ||
    local.hour > 23 ||
    local.minute > 59
  ) {
    throw new Error(`Invalid calendar time "${value}"`);
  }
}

function utcToZonedLocal(date: Date, timezone: string): LocalFields {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function offsetMinutes(utcMs: number, timezone: string): number {
  const local = utcToZonedLocal(new Date(utcMs), timezone);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  return Math.round((asUtc - Math.floor(utcMs / 60_000) * 60_000) / 60_000);
}

// Two passes handle DST: the offset at the first guess can differ from the offset at the answer.
// A local time skipped by a spring-forward gap resolves to the instant after the gap.
export function zonedLocalToUtc(local: LocalFields, timezone: string): Date {
  const naive = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  let utc = naive - offsetMinutes(naive, timezone) * 60_000;
  utc = naive - offsetMinutes(utc, timezone) * 60_000;
  return new Date(utc);
}
