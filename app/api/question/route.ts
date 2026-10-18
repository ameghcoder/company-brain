import { ZodError } from "zod";
import { toPublicResponse } from "@/answer/public-response";
import { ConfigError } from "@/config/server-env";
import { getPool } from "@/db/pool";
import { askQuestion, questionInputSchema } from "@/retrieve/ask";
import { sharedQuestionDependencies } from "@/retrieve/question-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { question, as_of?, context? } -> the public answer shape. Rate limiting belongs to the
// public demo milestone (LOC-5); input size is bounded here.
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const input = questionInputSchema.safeParse(body);
  if (!input.success) {
    return Response.json({ error: "Invalid question", issues: input.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) }, { status: 400 });
  }
  try {
    const result = await askQuestion(getPool(), input.data, await sharedQuestionDependencies());
    return Response.json(toPublicResponse(result));
  } catch (error) {
    if (error instanceof ConfigError) return Response.json({ error: "The model provider is not configured" }, { status: 503 });
    if (error instanceof ZodError) return Response.json({ error: "Invalid question" }, { status: 400 });
    console.error(`question failed: ${(error as Error).message}`);
    return Response.json({ error: "The question could not be answered" }, { status: 500 });
  }
}
