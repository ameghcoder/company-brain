import { providerConfig } from "@/config/server-env";
import { DEFAULT_FIXTURE_ROOT } from "@/ingest/load";
import { loadManifest } from "@/ingest/manifest";
import { readTopicRegistry } from "@/ingest/registry";
import { openAiStructuredModel } from "@/provider/openai-structured";
import type { AskDependencies } from "@/retrieve/ask";

// Live dependencies for answering questions: the planning model plus the company's topic
// registry and timezone. Planning needs only light reasoning; low effort keeps it fast.
export async function liveQuestionDependencies(): Promise<AskDependencies> {
  const manifest = await loadManifest(DEFAULT_FIXTURE_ROOT);
  return {
    planner: openAiStructuredModel(providerConfig(), { reasoningEffort: "low", maxCompletionTokens: 4_000 }),
    topics: await readTopicRegistry(manifest),
    timezone: manifest.company.timezone,
  };
}
