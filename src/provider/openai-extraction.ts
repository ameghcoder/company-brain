import type { ProviderConfig } from "@/config/server-env";
import type { ExtractionModel } from "@/extract/model";
import { openaiRequest, ProviderError } from "@/provider/openai-transport";

type ChatReply = { model: string; choices: Array<{ message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }> };

// Structured-output chat completion. Not yet verified against the live API (issue #2); the
// pipeline stores whatever this returns and treats anything unparseable as an invalid run.
export function openAiExtractionModel(config: ProviderConfig): ExtractionModel {
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
        },
        120_000,
      );
      const choice = reply.choices[0];
      if (choice?.message?.refusal) throw new ProviderError("the model refused the request", undefined);
      if (choice?.finish_reason === "length") throw new ProviderError("the response was cut off at the token limit", undefined);
      return { content: choice?.message?.content ?? "", servedModel: reply.model };
    },
  };
}
