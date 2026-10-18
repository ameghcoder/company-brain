import type { Answer } from "@/contracts/answer";
import type { EvidencePacket } from "@/answer/evidence-packet";

// The verified fallback: every packet fact stated in its own deterministic words with its own
// citations. Conflicting facts are stated together so no side appears alone.
export function deterministicAnswer(packet: EvidencePacket): Answer {
  const items: Answer["items"] = [];
  const done = new Set<string>();
  for (const fact of packet.facts) {
    if (done.has(fact.fact_id)) continue;
    const group = fact.conflict_group ? packet.facts.filter((other) => other.conflict_group === fact.conflict_group) : [fact];
    group.forEach((member) => done.add(member.fact_id));
    items.push({
      text: group.length > 1 ? `The records conflict. ${group.map((member) => member.summary).join(" ")}` : fact.summary,
      fact_ids: group.map((member) => member.fact_id),
      citation_ids: [...new Set(group.flatMap((member) => member.citation_ids))],
    });
  }
  return { items };
}
