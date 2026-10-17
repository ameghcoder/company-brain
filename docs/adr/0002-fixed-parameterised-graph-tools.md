# The LLM selects from fixed, parameterised graph tools; it never writes Cypher

The planner may only choose among `get_changes`, `explain_decision`, `get_owner`, `get_timeline`, and
`search_context`. The server validates tool names, project IDs, topic keys, times, and limits, then
runs pre-written parameterised queries against the pinned build. Generated Cypher was rejected: it
cannot be validated for evidence or temporal correctness, and it would let source or user text steer
queries. Full-text search input is escaped separately from Cypher parameterisation.
