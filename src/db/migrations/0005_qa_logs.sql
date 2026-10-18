-- One row per question: what was asked, how it was planned and resolved, which build and facts
-- were used, and how it ended. Written for debugging and evaluation; never shown to users raw.
CREATE TABLE qa_logs (
  qa_log_id      bigserial PRIMARY KEY,
  created_at     timestamptz NOT NULL DEFAULT now(),
  question       text NOT NULL,
  as_of          timestamptz NOT NULL,
  context        jsonb,
  build_id       text,
  outcome        text NOT NULL,
  planner        jsonb NOT NULL,
  raw_plan       text,
  resolved       jsonb,
  retrieved      jsonb,
  answer         jsonb,
  timings_ms     jsonb NOT NULL,
  error          text
);

CREATE INDEX qa_logs_created_idx ON qa_logs (created_at DESC);
