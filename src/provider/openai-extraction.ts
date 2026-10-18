import type { ProviderConfig } from "@/config/server-env";
import type { ExtractionModel } from "@/extract/model";
import { openAiStructuredModel } from "@/provider/openai-structured";

// Extraction runs with the model's default reasoning effort. Real extraction runs have not been
// reviewed yet (LOC-3 remainder); the pipeline stores and validates whatever comes back.
export function openAiExtractionModel(config: ProviderConfig): ExtractionModel {
  return openAiStructuredModel(config);
}
