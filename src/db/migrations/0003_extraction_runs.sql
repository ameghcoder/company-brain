-- One row per extraction cache key. The raw model response is stored before it is parsed, so a
-- failure is always visible and the exact output can be re-interpreted without another call.
CREATE TABLE extraction_runs (
  run_id           text PRIMARY KEY,
  document_id      text NOT NULL REFERENCES documents (document_id),
  version_id       text NOT NULL REFERENCES document_versions (version_id),
  window_index     integer NOT NULL,
  window_hash      text NOT NULL,
  config           jsonb NOT NULL,
  status           text NOT NULL CHECK (status IN ('failed', 'invalid', 'parsed')),
  raw_output       text,
  served_model     text,
  error            text,
  attempts         integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX extraction_runs_document_idx ON extraction_runs (document_id, version_id);
