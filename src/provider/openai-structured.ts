import type { ProviderConfig } from "@/config/server-env";
import { openaiRequest, ProviderError } from "@/provider/openai-transport";
import type { StructuredModel } from "@/provider/structured-model";

type ChatReply = { model: string; choices: Array<{ message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }> };

export type StructuredOptions = {
  // gpt-5-mini spends completion tokens on hidden reasoning first; keep headroom.
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  maxCompletionTokens?: number;
  timeoutMs?: number;
};

// Strict structured-output chat completion. Verified with gpt-5-mini through the planner (#12).
export function openAiStructuredModel(config: ProviderConfig, options: StructuredOptions = {}): StructuredModel {
  return {
    id: config.textModel,
    async complete(request) {
      // The provider wants the schema body; the JSON Schema dialect marker is not part of it.
      const schema = Object.fromEntries(Object.entries(request.schema).filter(([key]) => key !== "$schema"));
      const reply = await openaiRequest<ChatReply>(
        config,
        "POST",
        "/chat/completions",
        {
          model: config.textModel,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
          response_format: { type: "json_schema", json_schema: { name: request.schemaName, strict: true, schema } },
          ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
          max_completion_tokens: options.maxCompletionTokens ?? 16_000,
        },
        options.timeoutMs ?? 120_000,
      );
      const choice = reply.choices[0];
      if (choice?.message?.refusal) throw new ProviderError("the model refused the request", undefined);
      if (choice?.finish_reason === "length") throw new ProviderError("the response was cut off at the token limit", undefined);
      return { content: choice?.message?.content ?? "", servedModel: reply.model };
    },
  };
}
