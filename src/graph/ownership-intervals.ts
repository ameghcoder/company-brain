import type { OwnershipClaim } from "@/contracts/claims";

export type OwnershipInterval = {
  claimId: string;
  projectId: string;
  role: string;
  assigneeId: string;
  // Half-open [fromMs, toMs); toMs null means open-ended.
  fromMs: number;
  toMs: number | null;
  endReason: "stated" | "handoff" | null;
  endedBy: string | null;
};

export type OwnershipConflict = { projectId: string; role: string; claimIds: [string, string]; fromMs: number; toMs: number | null };

// An assignment ends only where the source says so: a stated end date, or an approved handoff
// claim that names it. Missing ends stay open; overlapping holders of an exclusive role are
// reported as conflicts rather than resolved by recency.
export function deriveOwnershipIntervals(
  claims: OwnershipClaim[],
  isExclusive: (projectId: string, role: string) => boolean,
): { intervals: OwnershipInterval[]; conflicts: OwnershipConflict[] } {
  const successorsOf = new Map<string, OwnershipClaim[]>();
  for (const claim of claims) {
    const previous = claim.payload.handoff_from;
    if (previous) successorsOf.set(previous, [...(successorsOf.get(previous) ?? []), claim]);
  }

  const intervals = claims.map((claim): OwnershipInterval => {
    const stated = claim.payload.effective_to ? Date.parse(claim.payload.effective_to.utc) : null;
    const handoffs = (successorsOf.get(claim.claim_id) ?? [])
      .map((successor) => ({ id: successor.claim_id, at: Date.parse(successor.payload.effective_from.utc) }))
      .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    const handoff = handoffs[0];
    const useHandoff = handoff !== undefined && (stated === null || handoff.at < stated);
    return {
      claimId: claim.claim_id,
      projectId: claim.project_id,
      role: claim.topic,
      assigneeId: claim.payload.assignee_id,
      fromMs: Date.parse(claim.payload.effective_from.utc),
      toMs: useHandoff ? handoff.at : stated,
      endReason: useHandoff ? "handoff" : stated !== null ? "stated" : null,
      endedBy: useHandoff ? handoff.id : null,
    };
  });

  const conflicts: OwnershipConflict[] = [];
  const sorted = [...intervals].sort((a, b) => a.fromMs - b.fromMs || a.claimId.localeCompare(b.claimId));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];
      if (!a || !b || a.projectId !== b.projectId || a.role !== b.role || !isExclusive(a.projectId, a.role)) continue;
      if (overlaps(a, b)) {
        conflicts.push({
          projectId: a.projectId,
          role: a.role,
          claimIds: [a.claimId, b.claimId],
          fromMs: Math.max(a.fromMs, b.fromMs),
          toMs: minEnd(a.toMs, b.toMs),
        });
      }
    }
  }
  return { intervals, conflicts };
}

export function activeAt(interval: OwnershipInterval, atMs: number): boolean {
  return interval.fromMs <= atMs && (interval.toMs === null || atMs < interval.toMs);
}

function overlaps(a: OwnershipInterval, b: OwnershipInterval): boolean {
  return a.fromMs < (b.toMs ?? Infinity) && b.fromMs < (a.toMs ?? Infinity);
}

function minEnd(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}
