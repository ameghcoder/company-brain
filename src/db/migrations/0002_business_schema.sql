-- Source of record for the LOC-2 vertical slice. extraction_runs, embedding_cache, and qa_logs
-- arrive with the milestones that write them (LOC-3, LOC-4).

CREATE TABLE sources (
  source_id   text PRIMARY KEY,
  source_type text NOT NULL CHECK (source_type IN ('csv', 'markdown', 'meeting')),
  origin_path text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE documents (
  document_id         text PRIMARY KEY,
  source_id           text NOT NULL REFERENCES sources (source_id),
  document_type       text NOT NULL CHECK (document_type IN ('roster', 'projects', 'assignments', 'document', 'meeting')),
  selected_version_id text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Immutable: rows are inserted once and never updated. version_id hashes text plus metadata.
CREATE TABLE document_versions (
  version_id    text PRIMARY KEY,
  document_id   text NOT NULL REFERENCES documents (document_id),
  content_hash  text NOT NULL,
  raw_text      text NOT NULL,
  title         text NOT NULL,
  author_id     text,
  event_at      jsonb NOT NULL,
  event_at_utc  timestamptz NOT NULL,
  project_ids   text[] NOT NULL DEFAULT '{}',
  metadata      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE documents
  ADD CONSTRAINT documents_selected_version_fk FOREIGN KEY (selected_version_id) REFERENCES document_versions (version_id);

-- Immutable: chunk_id is derived from version, chunker version, and position.
CREATE TABLE chunks (
  chunk_id             text PRIMARY KEY,
  version_id           text NOT NULL REFERENCES document_versions (version_id),
  chunker_version      text NOT NULL,
  position             integer NOT NULL,
  heading_path         text[] NOT NULL DEFAULT '{}',
  body                 text NOT NULL,
  start_offset         integer NOT NULL,
  end_offset           integer NOT NULL,
  token_estimate       integer NOT NULL,
  turns                jsonb NOT NULL DEFAULT '[]',
  embedding_input      text NOT NULL,
  embedding_input_hash text NOT NULL,
  UNIQUE (version_id, chunker_version, position)
);

CREATE TABLE entities (
  entity_id      text PRIMARY KEY,
  kind           text NOT NULL CHECK (kind IN ('person', 'team', 'project')),
  canonical_name text NOT NULL,
  attributes     jsonb NOT NULL DEFAULT '{}'
);

-- Aliases are scoped by entity kind. The same normalized alias may map to several entities;
-- that ambiguity is kept, never resolved by picking one.
CREATE TABLE entity_aliases (
  kind             text NOT NULL,
  alias_normalized text NOT NULL,
  entity_id        text NOT NULL REFERENCES entities (entity_id),
  alias            text NOT NULL,
  PRIMARY KEY (kind, alias_normalized, entity_id)
);

CREATE TABLE claims (
  claim_id      text PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('decision', 'ownership', 'supersession')),
  project_id    text NOT NULL REFERENCES entities (entity_id),
  topic         text NOT NULL,
  origin        text NOT NULL CHECK (origin IN ('structured', 'fixture_reviewed', 'extracted')),
  review_status text NOT NULL CHECK (review_status IN ('pending', 'approved', 'rejected')),
  review_note   text,
  payload       jsonb NOT NULL,
  evidence      jsonb NOT NULL,
  recorded_at   jsonb NOT NULL,
  effective_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX claims_scope_idx ON claims (project_id, topic, review_status);

CREATE TABLE graph_builds (
  build_id      text PRIMARY KEY,
  graph_name    text NOT NULL UNIQUE,
  state         text NOT NULL CHECK (state IN ('building', 'built', 'checked', 'failed')),
  config        jsonb NOT NULL,
  selection     jsonb NOT NULL,
  integrity     jsonb,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

-- One row per company: which checked build new questions pin.
CREATE TABLE app_state (
  company_id      text PRIMARY KEY,
  active_build_id text REFERENCES graph_builds (build_id),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
