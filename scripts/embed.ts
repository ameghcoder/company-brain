import { ConfigError, providerConfig } from "@/config/server-env";
import { closePool, getPool } from "@/db/pool";
import { embedChunks } from "@/embed/embed";
import { openAiEmbedder } from "@/provider/openai-embeddings";

// PAID: embeds selected chunks that have no cached vector for the configured model/dimensions.
// Not verified until the provider works (issue #2). Builds never call this.
try {
  const config = providerConfig();
  const result = await embedChunks(getPool(), openAiEmbedder(config), { model: config.embeddingModel, dimensions: config.embeddingDimensions });
  console.log(`missing: ${result.missing}; embedded: ${result.embedded}; batches: ${result.batches} (${config.embeddingModel}, ${config.embeddingDimensions} dims)`);
} catch (error) {
  if (error instanceof ConfigError) {
    console.log("NOT VERIFIED  embedding needs provider configuration (see issue #2)");
    console.log(error.message);
    process.exitCode = 2;
  } else {
    console.error(`embed failed: ${(error as Error).message}`);
    process.exitCode = 1;
  }
} finally {
  await closePool();
}
