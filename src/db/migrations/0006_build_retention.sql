-- When a build stopped being active, and when its FalkorDB graph was deleted. Rows are kept as
-- provenance after pruning; only the graph goes.
ALTER TABLE graph_builds
  ADD COLUMN retired_at timestamptz,
  ADD COLUMN pruned_at  timestamptz;
