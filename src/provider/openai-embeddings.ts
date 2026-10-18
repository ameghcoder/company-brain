import type { ProviderConfig } from "@/config/server-env";
import type { Embedder } from "@/embed/embed";
import { openaiRequest, ProviderError } from "@/provider/openai-transport";

type EmbeddingReply = { data: Array<{ index: number; embedding: number[] }> };

// Not yet verified against the live API (issue #2). The pipeline validates every vector anyway.
export function openAiEmbedder(config: ProviderConfig): Embedder {
  return {
    model: config.embeddingModel,
    dimensions: config.embeddingDimensions,
    async embed(inputs) {
      const reply = await openaiRequest<EmbeddingReply>(config, "POST", "/embeddings", {
        model: config.embeddingModel,
        input: inputs,
        dimensions: config.embeddingDimensions,
      });
      const ordered = [...reply.data].sort((a, b) => a.index - b.index);
      if (ordered.length !== inputs.length) throw new ProviderError(`expected ${inputs.length} embeddings, got ${ordered.length}`, undefined);
      return ordered.map((item) => item.embedding);
    },
  };
}
