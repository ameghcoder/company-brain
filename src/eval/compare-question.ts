import { compareCase, type CaseResult, type ExpectedCase } from "@/eval/compare";
import type { QuestionResult } from "@/retrieve/ask";

export type QuestionCase = {
  case_id: string;
  question: string;
  context?: { project: string | null; topic: string | null };
  accept_outcomes?: string[];
};

// Compares a planned natural-language answer with the case's independent expectations: the
// overall outcome, and the facts of the step that answers the expected request.
export function compareQuestion(expected: ExpectedCase, nl: QuestionCase, result: QuestionResult): CaseResult & { request_matched: boolean } {
  const failures: string[] = [];
  const allowed = nl.accept_outcomes ?? [String(expected.expect.outcome)];
  if (!allowed.includes(result.outcome)) failures.push(`outcome: expected ${allowed.join(" or ")}, got ${result.outcome}`);

  const request = expected.request;
  if (request.intent === "resolve_alias") {
    if (expected.expect.outcome === "needs_clarification" && result.outcome === "needs_clarification") {
      const got = (result.clarification?.candidates ?? []).map((candidate) => candidate.id).sort();
      const want = [...((expected.expect.candidates as string[]) ?? [])].sort();
      if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`clarification candidates: got [${got.join(", ")}]`);
    }
    return { id: expected.id, question: nl.question, ok: failures.length === 0, outcome: result.outcome, failures, request_matched: true };
  }

  const topicKey = request.intent === "owner" ? "role" : "topic";
  const step = result.steps.find(
    (candidate) =>
      candidate.request?.intent === request.intent &&
      candidate.request?.project === request.project &&
      (request[topicKey] === undefined || (candidate.request as Record<string, unknown>)[topicKey] === request[topicKey]),
  );
  if (!step?.response) {
    // A subject the records do not contain may legitimately fail before any request is made.
    const resolvedAway = expected.expect.outcome === "insufficient_evidence" && result.outcome === "insufficient_evidence";
    if (!resolvedAway) failures.push(`no step ran the expected ${request.intent} request for ${String(request.project)}/${String(request[topicKey] ?? "-")}`);
    return { id: expected.id, question: nl.question, ok: failures.length === 0, outcome: result.outcome, failures, request_matched: false };
  }
  const facts = compareCase(expected, step.response);
  failures.push(...facts.failures);
  return { id: expected.id, question: nl.question, ok: failures.length === 0, outcome: result.outcome, failures, request_matched: true };
}
