import { readFile } from "node:fs/promises";
import { z } from "zod";
import { claimIdSchema, type Claim } from "@/contracts/claims";
import { parseLocalTime } from "@/time/company-time";

// Reviewer decisions for extracted claims, kept in a versioned file and applied on every
// materialisation, so a correction survives re-interpretation of the same run.

const correctionSchema = z.strictObject({
  choice: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  topic: z.string().optional(),
  rationale: z.string().nullable().optional(),
  decided_by: z.string().nullable().optional(),
  decided_at: z.string().optional(),
  effective_at: z.string().nullable().optional(),
  assignee: z.string().optional(),
  effective_from: z.string().optional(),
  effective_to: z.string().nullable().optional(),
});

const reviewSchema = z.discriminatedUnion("action", [
  z.strictObject({ claim_id: claimIdSchema, action: z.literal("approve"), note: z.string().optional() }),
  z.strictObject({ claim_id: claimIdSchema, action: z.literal("reject"), note: z.string().min(1) }),
  z.strictObject({ claim_id: claimIdSchema, action: z.literal("correct"), note: z.string().min(1), set: correctionSchema }),
]);
export type Review = z.infer<typeof reviewSchema>;

const approvalsFileSchema = z.object({ about: z.string().optional(), reviews: z.array(reviewSchema) });

export async function readApprovals(file: string): Promise<Review[]> {
  const reviews = approvalsFileSchema.parse(JSON.parse(await readFile(file, "utf8"))).reviews;
  const ids = reviews.map((review) => review.claim_id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) throw new Error(`Approvals file reviews ${duplicate} more than once`);
  return reviews;
}

const FIELDS_BY_KIND: Record<Claim["kind"], (keyof z.infer<typeof correctionSchema>)[]> = {
  decision: ["choice", "title", "topic", "rationale", "decided_by", "decided_at", "effective_at"],
  ownership: ["topic", "assignee", "effective_from", "effective_to"],
  supersession: ["effective_at"],
};

export function applyReviews(
  claims: Claim[],
  reviews: Review[],
  timezone: string,
): { claims: Claim[]; problems: { claimId: string; message: string }[] } {
  const problems: { claimId: string; message: string }[] = [];
  const byId = new Map(reviews.map((review) => [review.claim_id, review]));
  const known = new Set(claims.map((claim) => claim.claim_id));
  for (const review of reviews) {
    if (!known.has(review.claim_id)) {
      problems.push({ claimId: review.claim_id, message: "review refers to a claim no current extraction run produced (stale after re-extraction?)" });
    }
  }

  const reviewed = claims.map((claim): Claim => {
    const review = byId.get(claim.claim_id);
    if (!review) return claim;
    if (review.action === "approve") return { ...claim, review_status: "approved", review_note: review.note ?? null };
    if (review.action === "reject") return { ...claim, review_status: "rejected", review_note: review.note };

    const fields = Object.keys(review.set) as (keyof typeof review.set)[];
    const disallowed = fields.filter((field) => !FIELDS_BY_KIND[claim.kind].includes(field));
    if (disallowed.length) {
      problems.push({ claimId: claim.claim_id, message: `correction sets ${disallowed.join(", ")}, which a ${claim.kind} claim does not have` });
      return claim;
    }
    try {
      const corrected = correct(claim, review.set, timezone);
      return { ...corrected, review_status: "approved", review_note: `Corrected (${fields.join(", ")}): ${review.note}` };
    } catch (error) {
      problems.push({ claimId: claim.claim_id, message: `correction failed: ${(error as Error).message}` });
      return claim;
    }
  });
  return { claims: reviewed, problems };
}

function correct(claim: Claim, set: z.infer<typeof correctionSchema>, timezone: string): Claim {
  const at = (value: string) => parseLocalTime(value, timezone);
  const topic = set.topic ?? claim.topic;
  switch (claim.kind) {
    case "decision": {
      const payload = { ...claim.payload };
      if (set.choice !== undefined) payload.choice = set.choice;
      if (set.title !== undefined) payload.title = set.title;
      if (set.rationale !== undefined) payload.rationale = set.rationale;
      if (set.decided_by !== undefined) payload.decided_by = set.decided_by;
      if (set.decided_at !== undefined) payload.decided_at = at(set.decided_at);
      if (set.effective_at !== undefined || set.decided_at !== undefined) {
        const stated = set.effective_at !== undefined ? set.effective_at : payload.effective_basis === "stated" ? payload.effective_at?.value ?? null : null;
        payload.effective_at = stated ? at(stated) : payload.decided_at;
        payload.effective_basis = stated ? "stated" : "decision_date";
      }
      return { ...claim, topic, payload };
    }
    case "ownership": {
      const payload = { ...claim.payload };
      if (set.assignee !== undefined) payload.assignee_id = set.assignee;
      if (set.effective_from !== undefined) payload.effective_from = at(set.effective_from);
      if (set.effective_to !== undefined) payload.effective_to = set.effective_to ? at(set.effective_to) : null;
      return { ...claim, topic, payload };
    }
    case "supersession":
      return { ...claim, payload: { ...claim.payload, effective_at: set.effective_at ? at(set.effective_at) : claim.payload.effective_at } };
  }
}
