-- Cached embeddings keyed by the full embedding input hash, model, and dimensions, so a changed
-- input or model setting can never reuse a stale vector. Builds read only from here.
CREATE TABLE embedding_cache (
  input_hash  text NOT NULL,
  model       text NOT NULL,
  dimensions  integer NOT NULL CHECK (dimensions > 0),
  vector      real[] NOT NULL CHECK (array_length(vector, 1) = dimensions),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (input_hash, model, dimensions)
);
