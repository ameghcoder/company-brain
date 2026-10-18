import { z } from "zod";

// What the planning model returns for one question. Bump the version for any change.
export const PLAN_SCHEMA_VERSION = "plan-v1";

export const timeReferenceSchema = z.strictObject({
  // now: the as-of time; on_date: state at the end of `date`; before_date: just before `date`
  // starts; start_of_date: the moment `date` starts; date_range: [date, end_date] inclusive days;
  // all_time: no time limit (timelines).
  kind: z.enum(["now", "on_date", "before_date", "start_of_date", "date_range", "all_time"]),
  date: z.string().nullable(),
  end_date: z.string().nullable(),
});
export type TimeReference = z.infer<typeof timeReferenceSchema>;

export const planStepSchema = z.strictObject({
  intent: z.enum(["owner", "explain", "changes", "timeline"]),
  // The project as the user wrote it; the server resolves it against the registry.
  project_mention: z.string().nullable(),
  // A decision topic or ownership role key from the allowed list, or null if none fits.
  topic: z.string().nullable(),
  // The user's own words for the subject, kept for reporting when no topic fits.
  subject: z.string().nullable(),
  time: timeReferenceSchema,
});
export type PlanStep = z.infer<typeof planStepSchema>;

export const planSchema = z.strictObject({
  status: z.enum(["plan", "clarify", "out_of_scope"]),
  clarification: z.string().nullable(),
  steps: z.array(planStepSchema),
  person_mentions: z.array(z.string()),
});
export type Plan = z.infer<typeof planSchema>;

export function planJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(planSchema) as Record<string, unknown>;
}
