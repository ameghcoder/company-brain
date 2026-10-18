import { z } from "zod";

// Server-side configuration only. Never import this from a client component, and never add
// NEXT_PUBLIC_* variables for credentials: Next.js inlines those into the browser bundle.

const DEV_DATABASE_URL = "postgresql://company_brain:company_brain_dev@127.0.0.1:5432/company_brain";

export class ConfigError extends Error {
  override name = "ConfigError";
}

// Zod issue messages can include the received value, which may be a secret pasted into the
// wrong variable. Report only variable names and the expectation.
function parseEnv<T extends z.ZodTypeAny>(schema: T, source: Record<string, string | undefined>): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${describeIssue(issue)}`);
    throw new ConfigError(`Invalid server configuration:\n  ${problems.join("\n  ")}`);
  }
  return result.data;
}

function describeIssue(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "invalid_value":
      return `expected one of ${issue.values.map(String).join(", ")}`;
    case "invalid_type":
      return `expected ${issue.expected}`;
    case "custom":
      // Only our own refinements produce custom issues, and their messages contain no input.
      return issue.message;
    default:
      return "invalid value";
  }
}

const emptyAsUndefined = (value: unknown) => (value === "" ? undefined : value);

const databaseSchema = z.object({
  DATABASE_URL: z.preprocess(emptyAsUndefined, z.url().default(DEV_DATABASE_URL)),
});

export function databaseConfig() {
  const env = parseEnv(databaseSchema, process.env);
  return { connectionString: env.DATABASE_URL };
}

const falkordbSchema = z.object({
  FALKORDB_HOST: z.preprocess(emptyAsUndefined, z.string().min(1).default("127.0.0.1")),
  FALKORDB_PORT: z.preprocess(emptyAsUndefined, z.coerce.number().int().min(1).max(65535).default(6379)),
  FALKORDB_GRAPH_PREFIX: z.preprocess(
    emptyAsUndefined,
    z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,40}$/, "lowercase letters, digits, underscores")
      .default("company_brain"),
  ),
});

export function falkordbConfig() {
  const env = parseEnv(falkordbSchema, process.env);
  return { host: env.FALKORDB_HOST, port: env.FALKORDB_PORT, graphPrefix: env.FALKORDB_GRAPH_PREFIX };
}

const providerSchema = z
  .object({
    OPENAI_AUTH_MODE: z.enum(["network_secret", "api_key"]),
    OPENAI_API_KEY: z.preprocess(emptyAsUndefined, z.string().min(1).optional()),
    OPENAI_BASE_URL: z.preprocess(emptyAsUndefined, z.url().default("https://api.openai.com/v1")),
    // No defaults: a model is recorded here only after check:provider has verified access to it.
    OPENAI_TEXT_MODEL: z.preprocess(emptyAsUndefined, z.string().min(1)),
    OPENAI_EMBEDDING_MODEL: z.preprocess(emptyAsUndefined, z.string().min(1)),
    OPENAI_EMBEDDING_DIMENSIONS: z.preprocess(emptyAsUndefined, z.coerce.number().int().min(1).max(4096)),
  })
  .superRefine((env, ctx) => {
    if (env.OPENAI_AUTH_MODE === "api_key" && !env.OPENAI_API_KEY) {
      ctx.addIssue({ code: "custom", path: ["OPENAI_API_KEY"], message: "required when OPENAI_AUTH_MODE=api_key" });
    }
  });

export type ProviderConfig = {
  authMode: "network_secret" | "api_key";
  apiKey: string | undefined;
  baseUrl: string;
  textModel: string;
  embeddingModel: string;
  embeddingDimensions: number;
};

export function providerConfig(): ProviderConfig {
  const env = parseEnv(providerSchema, process.env);
  return {
    authMode: env.OPENAI_AUTH_MODE,
    // network_secret mode: the cloud egress proxy attaches Authorization, so the app sends none.
    apiKey: env.OPENAI_AUTH_MODE === "api_key" ? env.OPENAI_API_KEY : undefined,
    baseUrl: env.OPENAI_BASE_URL.replace(/\/+$/, ""),
    textModel: env.OPENAI_TEXT_MODEL,
    embeddingModel: env.OPENAI_EMBEDDING_MODEL,
    embeddingDimensions: env.OPENAI_EMBEDDING_DIMENSIONS,
  };
}

const extractionModelSchema = z.object({ OPENAI_TEXT_MODEL: z.preprocess(emptyAsUndefined, z.string().min(1)) });

// The model ID alone (no credentials) identifies extraction runs, so stored runs can be
// re-interpreted offline without provider access.
export function extractionModelId(): string {
  return parseEnv(extractionModelSchema, process.env).OPENAI_TEXT_MODEL;
}

const embeddingSettingsSchema = z.object({
  OPENAI_EMBEDDING_MODEL: z.preprocess(emptyAsUndefined, z.string().min(1).optional()),
  OPENAI_EMBEDDING_DIMENSIONS: z.preprocess(emptyAsUndefined, z.coerce.number().int().min(1).max(4096).optional()),
});

export type EmbeddingSettings = { model: string; dimensions: number };

// Which cached vectors builds use. Needs no credentials: builds only read the cache. Returns
// undefined when embeddings are not configured (builds then project no vectors).
export function embeddingSettings(): EmbeddingSettings | undefined {
  const env = parseEnv(embeddingSettingsSchema, process.env);
  if (env.OPENAI_EMBEDDING_MODEL === undefined && env.OPENAI_EMBEDDING_DIMENSIONS === undefined) return undefined;
  if (env.OPENAI_EMBEDDING_MODEL === undefined || env.OPENAI_EMBEDDING_DIMENSIONS === undefined) {
    throw new ConfigError("Invalid server configuration:\n  OPENAI_EMBEDDING_MODEL and OPENAI_EMBEDDING_DIMENSIONS must be set together");
  }
  return { model: env.OPENAI_EMBEDDING_MODEL, dimensions: env.OPENAI_EMBEDDING_DIMENSIONS };
}

const intSetting = (fallback: number, max: number) => z.preprocess(emptyAsUndefined, z.coerce.number().int().min(1).max(max).default(fallback));
const questionLimitsSchema = z.object({
  QUESTION_MAX_BODY_BYTES: intSetting(4096, 65_536),
  QUESTION_RATE_LIMIT: intSetting(10, 10_000),
  QUESTION_RATE_WINDOW_SECONDS: intSetting(600, 86_400),
  QUESTION_MAX_CONCURRENT: intSetting(3, 100),
  QUESTION_DAILY_BUDGET: intSetting(500, 1_000_000),
  TRUST_PROXY: z.preprocess(emptyAsUndefined, z.enum(["0", "1"]).default("0")),
});

// Public-demo limits on the paid question API; the defaults suit one small demo instance.
export function questionLimitsConfig() {
  const env = parseEnv(questionLimitsSchema, process.env);
  return {
    maxBodyBytes: env.QUESTION_MAX_BODY_BYTES,
    perClient: { limit: env.QUESTION_RATE_LIMIT, windowMs: env.QUESTION_RATE_WINDOW_SECONDS * 1000 },
    maxConcurrent: env.QUESTION_MAX_CONCURRENT,
    dailyBudget: env.QUESTION_DAILY_BUDGET,
    trustProxy: env.TRUST_PROXY === "1",
  };
}
