import { ZodError } from "zod";
import { toPublicResponse } from "@/answer/public-response";
import { ConfigError, questionLimitsConfig } from "@/config/server-env";
import { getPool } from "@/db/pool";
import { askQuestion, questionInputSchema, type AskDependencies } from "@/retrieve/ask";
import { QuestionLimiter } from "@/server/question-limits";

// POST /api/question: size and rate limits, then validation, then the question pipeline. Every
// refusal happens before any model call.
export function questionHandler(getDeps: () => Promise<AskDependencies>, getLimiter: () => QuestionLimiter) {
  return async function POST(request: Request): Promise<Response> {
    let limiter: QuestionLimiter;
    try {
      limiter = getLimiter();
    } catch (error) {
      if (error instanceof ConfigError) return Response.json({ error: "The question limits are misconfigured" }, { status: 503 });
      throw error;
    }

    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > limiter.config.maxBodyBytes) return tooLarge(limiter);
    const text = await request.text();
    if (Buffer.byteLength(text) > limiter.config.maxBodyBytes) return tooLarge(limiter);

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return Response.json({ error: "Body must be JSON" }, { status: 400 });
    }
    const input = questionInputSchema.safeParse(body);
    if (!input.success) {
      return Response.json({ error: "Invalid question", issues: input.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) }, { status: 400 });
    }

    const admission = limiter.admit(limiter.clientKey(request.headers));
    if (!admission.ok) {
      return Response.json({ error: admission.message, limit: admission.reason }, { status: 429, headers: { "retry-after": String(admission.retryAfterSeconds) } });
    }
    try {
      const result = await askQuestion(getPool(), input.data, await getDeps());
      return Response.json(toPublicResponse(result));
    } catch (error) {
      if (error instanceof ConfigError) return Response.json({ error: "The model provider is not configured" }, { status: 503 });
      if (error instanceof ZodError) return Response.json({ error: "Invalid question" }, { status: 400 });
      console.error(`question failed: ${(error as Error).message}`);
      return Response.json({ error: "The question could not be answered" }, { status: 500 });
    } finally {
      admission.release();
    }
  };
}

function tooLarge(limiter: QuestionLimiter) {
  return Response.json({ error: `Request body over ${limiter.config.maxBodyBytes} bytes` }, { status: 413 });
}

let shared: QuestionLimiter | undefined;
export function sharedLimiter(): QuestionLimiter {
  shared ??= new QuestionLimiter(questionLimitsConfig());
  return shared;
}
