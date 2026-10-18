import { z } from "zod";

export const ANSWER_SCHEMA_VERSION = "answer-v1";

// Each item is one or two sentences; it lists the packet facts it states and the citations
// supporting them. Checks reject items whose wording goes beyond their facts.
export const answerSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      text: z.string(),
      fact_ids: z.array(z.string()),
      citation_ids: z.array(z.string()),
    }),
  ),
});
export type Answer = z.infer<typeof answerSchema>;
export type AnswerItem = Answer["items"][number];

export function answerJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(answerSchema) as Record<string, unknown>;
}
