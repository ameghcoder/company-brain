# Search selects a topic only when a full-text match corroborates it

`search_context` runs when a question names a subject that matches no registered topic ("What did
Atlas decide about chargebacks?"). It ranks chunks by full-text and vector search with
reciprocal-rank fusion, but a decision or ownership topic becomes a candidate only if a chunk with a
full-text match evidences one of its claims. Chunks found only by vector search are returned as
related reading and never select a topic.

We chose this because vector distance on the real embeddings (`text-embedding-3-small`, 1536
dimensions, 45 chunks) does not separate related from unrelated questions. The nearest chunk for
"CRM vendor", which no source discusses, was at cosine distance 0.538; the nearest for
"chargebacks", which the fraud-screening decision discusses, was at 0.666. No distance ceiling admits
the second and rejects the first, so a vector-only rule would turn absent subjects into confident
answers about the wrong topic.

## Consequences

- A subject the sources discuss only in other words (a synonym with no shared term) gets
  `insufficient_evidence` instead of an answer. We accept that; a wrong topic is worse.
- Full-text terms are lowercase words of three or more characters, with stopwords dropped, and all
  must match. Every RediSearch operator character is removed, so search text cannot alter the query.
- Search still works on a build without vectors or without a matching embedder (full-text only),
  and says so in `incomplete`.
- A search counts toward the three graph-tool calls a question may make.
