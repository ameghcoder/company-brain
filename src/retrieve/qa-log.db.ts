import type pg from "pg";

export type QaLogRow = {
  question: string;
  asOf: string;
  context: unknown;
  buildId: string | null;
  outcome: string;
  planner: unknown;
  rawPlan: string | null;
  resolved: unknown;
  retrieved: unknown;
  answer: unknown;
  timingsMs: Record<string, number>;
  error: string | null;
};

export async function insertQaLog(db: pg.Pool, row: QaLogRow): Promise<number> {
  const result = await db.query<{ qa_log_id: string }>(
    `INSERT INTO qa_logs (question, as_of, context, build_id, outcome, planner, raw_plan, resolved, retrieved, answer, timings_ms, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING qa_log_id`,
    [
      row.question,
      row.asOf,
      JSON.stringify(row.context ?? null),
      row.buildId,
      row.outcome,
      JSON.stringify(row.planner),
      row.rawPlan,
      JSON.stringify(row.resolved ?? null),
      JSON.stringify(row.retrieved ?? null),
      JSON.stringify(row.answer ?? null),
      JSON.stringify(row.timingsMs),
      row.error,
    ],
  );
  return Number(result.rows[0]?.qa_log_id);
}
