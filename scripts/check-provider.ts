import { ConfigError, providerConfig, type ProviderConfig } from "@/config/server-env";
import { openaiRequest, ProviderError } from "@/provider/openai-transport";
import { printResults, type CheckResult } from "@/smoke/check-result";

// Opt-in, paid-but-tiny provider check: one short text completion and one short embedding.
// Never run from build or bootstrap. Prints no credentials, headers, or provider error text.

type ChatReply = { model: string; choices: Array<{ message?: { content?: string | null } }> };
type EmbeddingReply = { model: string; data: Array<{ embedding: number[] }> };

async function run(config: ProviderConfig): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const attempt = async (name: string, fn: () => Promise<string>) => {
    try {
      results.push({ name, ok: true, detail: await fn() });
    } catch (error) {
      const detail = error instanceof ProviderError ? error.message : `unexpected error (${(error as Error).name})`;
      results.push({ name, ok: false, detail });
    }
  };

  await attempt("provider: auth + model listing", async () => {
    await openaiRequest(config, "GET", `/models/${encodeURIComponent(config.textModel)}`);
    await openaiRequest(config, "GET", `/models/${encodeURIComponent(config.embeddingModel)}`);
    return `mode=${config.authMode}; ${config.textModel} and ${config.embeddingModel} visible`;
  });
  if (!results[0]?.ok) return results;

  await attempt("provider: text generation", async () => {
    const reply = await openaiRequest<ChatReply>(config, "POST", "/chat/completions", {
      model: config.textModel,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
      max_completion_tokens: 16,
    });
    const text = reply.choices[0]?.message?.content ?? "";
    if (!text.trim()) throw new ProviderError("empty completion", undefined);
    return `model=${reply.model}, ${text.trim().length} chars returned`;
  });

  await attempt(`provider: embedding (${config.embeddingDimensions} dims)`, async () => {
    const reply = await openaiRequest<EmbeddingReply>(config, "POST", "/embeddings", {
      model: config.embeddingModel,
      input: "Company Brain provider connectivity check",
      dimensions: config.embeddingDimensions,
    });
    const vector = reply.data[0]?.embedding ?? [];
    if (vector.length !== config.embeddingDimensions) {
      throw new ProviderError(`expected ${config.embeddingDimensions} dims, got ${vector.length}`, undefined);
    }
    if (!vector.every(Number.isFinite)) throw new ProviderError("non-finite vector values", undefined);
    return `model=${reply.model}, length=${vector.length}, all finite`;
  });
  return results;
}

let config: ProviderConfig;
try {
  config = providerConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.log("NOT VERIFIED  provider configuration missing or invalid");
  console.log(error.message);
  process.exit(2);
}
process.exitCode = printResults(await run(config)) ? 0 : 1;
