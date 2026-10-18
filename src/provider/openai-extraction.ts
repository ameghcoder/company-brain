import type { ProviderConfig } from "@/config/server-env";
import type { ExtractionModel } from "@/extract/model";
import { openAiStructuredModel } from "@/provider/openai-structured";

// Extraction runs with the model's default reasoning effort; the pipeline stores and validates
// whatever comes back, and every claim still needs review (real runs reviewed in #22).
export function openAiExtractionModel(config: ProviderConfig): ExtractionModel {
  return openAiStructuredModel(config);
}
