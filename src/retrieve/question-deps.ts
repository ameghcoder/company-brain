import { providerConfig } from "@/config/server-env";
import { DEFAULT_FIXTURE_ROOT } from "@/ingest/load";
import { loadManifest } from "@/ingest/manifest";
import { readTopicRegistry } from "@/ingest/registry";
import { openAiEmbedder } from "@/provider/openai-embeddings";
import { openAiStructuredModel } from "@/provider/openai-structured";
import type { AskDependencies } from "@/retrieve/ask";

let cached: Promise<AskDependencies> | undefined;

// The API reuses one set of dependencies per server process.
export function sharedQuestionDependencies(): Promise<AskDependencies> {
  cached ??= liveQuestionDependencies().catch((error) => {
    cached = undefined;
    throw error;
  });
  return cached;
}

// Live dependencies for answering questions: the planning model plus the company's topic
// registry and timezone. Planning needs only light reasoning; low effort keeps it fast.
export async function liveQuestionDependencies(): Promise<AskDependencies> {
  const manifest = await loadManifest(DEFAULT_FIXTURE_ROOT);
  const config = providerConfig();
  return {
    planner: openAiStructuredModel(config, { reasoningEffort: "low", maxCompletionTokens: 4_000 }),
    answerer: openAiStructuredModel(config, { reasoningEffort: "low", maxCompletionTokens: 8_000 }),
    // Embeds search text for search_context with the same model as the chunk vectors.
    embedder: openAiEmbedder(config),
    topics: await readTopicRegistry(manifest),
    timezone: manifest.company.timezone,
  };
}
