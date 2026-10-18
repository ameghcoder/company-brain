import { sharedQuestionDependencies } from "@/retrieve/question-deps";
import { questionHandler, sharedLimiter } from "@/server/question-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { question, as_of?, context? } -> the public answer shape, behind the public-demo limits.
export const POST = questionHandler(sharedQuestionDependencies, sharedLimiter);
