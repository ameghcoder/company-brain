-- Infrastructure smoke table only. The business schema arrives with the graph/data milestone.
CREATE TABLE smoke_checks (
  check_key  text PRIMARY KEY,
  payload    jsonb NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now()
);
