import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ConfigError, extractionModelId, providerConfig } from "@/config/server-env";
import { closePool, getPool } from "@/db/pool";
import { renderReviewReport } from "@/extract/review-report";
import { extractClaims, type ExtractionSummary } from "@/extract/run-extraction";
import { DEFAULT_FIXTURE_ROOT } from "@/ingest/load";
import { loadManifest } from "@/ingest/manifest";
import { openAiExtractionModel } from "@/provider/openai-extraction";

// Usage: tsx scripts/extract.ts <run | report | apply>
//   run     calls the model for windows without a parsed run (paid), then stores pending claims
//   report  re-interprets stored runs offline and writes the review report (no writes, no calls)
//   apply   re-interprets stored runs offline, applies the approvals file, and stores the result
const command = process.argv[2] ?? "";

async function main(): Promise<boolean> {
  if (!["run", "report", "apply"].includes(command)) {
    console.error("usage: tsx scripts/extract.ts <run | report | apply>");
    return false;
  }
  const manifest = await loadManifest(DEFAULT_FIXTURE_ROOT);
  let summary: ExtractionSummary;
  if (command === "run") {
    const config = providerConfig();
    summary = await extractClaims(getPool(), manifest, { model: openAiExtractionModel(config), modelId: config.textModel, write: true });
  } else {
    summary = await extractClaims(getPool(), manifest, { modelId: extractionModelId(), write: command === "apply" });
  }

  const dir = path.resolve("review/reports");
  await mkdir(dir, { recursive: true });
  const now = new Date();
  const file = path.join(dir, `review-${now.toISOString().replace(/[:.]/g, "-")}.md`);
  await writeFile(file, renderReviewReport(summary, now));

  const statuses = summary.runs.reduce<Record<string, number>>((acc, run) => ({ ...acc, [run.status]: (acc[run.status] ?? 0) + 1 }), {});
  console.log(`windows: ${summary.windows}; runs ${JSON.stringify(statuses)}; reused ${summary.reused}; model calls ${summary.called}`);
  console.log(`claims: ${summary.claims.length}; problems: ${summary.problems.length}; unresolved mentions: ${summary.mentions.length}`);
  if (summary.written) console.log(`stored: ${JSON.stringify(summary.written)}`);
  console.log(`review report: ${path.relative(process.cwd(), file)}`);
  return !summary.runs.some((run) => run.status === "failed" || run.status === "invalid");
}

try {
  process.exitCode = (await main()) ? 0 : 1;
} catch (error) {
  if (error instanceof ConfigError) {
    console.log("NOT VERIFIED  extraction needs provider configuration (see issue #2)");
    console.log(error.message);
    process.exitCode = 2;
  } else {
    console.error(`extract ${command} failed: ${(error as Error).message}`);
    process.exitCode = 1;
  }
} finally {
  await closePool();
}
