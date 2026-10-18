import type { Answer } from "@/contracts/answer";
import { MAIN_FACT_KINDS, type EvidencePacket, type PacketFact } from "@/answer/evidence-packet";

// Server checks on a generated answer. They reduce unsupported output; they do not prove that
// the wording is entailed by the evidence, which is why the eval cases remain necessary.

export type NamedEntity = { id: string; kind: string; name: string; aliases: string[] };

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_PATTERN = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/g;
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const CAUSAL = /\b(because|due to|so that|in order to|the reason|reasons?|rationale|motivated|driven by)\b/i;
const NOT_RECORDED = /\b(not recorded|no recorded|isn't recorded|is not recorded|unknown|not documented|undocumented|not stated|doesn't say|does not say|no rationale|no reason)\b/i;
const DECIDER = /\b(decided by|approved by|made by|signed off)\b/i;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (text: string, phrase: string) => new RegExp(`(?<![A-Za-z0-9])${escape(phrase)}(?![A-Za-z0-9])`).test(text);

// Dates in text, as YYYY-MM-DD when a year is given, else MM-DD.
export function datesIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(ISO_DATE)) found.push(`${match[1]}-${match[2]}-${match[3]}`);
  for (const match of text.matchAll(MONTH_PATTERN)) {
    const month = MONTHS.findIndex((name) => name.startsWith((match[1] ?? "").toLowerCase().slice(0, 3))) + 1;
    const mmdd = `${String(month).padStart(2, "0")}-${String(Number(match[2])).padStart(2, "0")}`;
    found.push(match[3] ? `${match[3]}-${mmdd}` : mmdd);
  }
  return found;
}

// Names a reader would recognise: people by full name or first-name alias, projects by name or
// alias, teams only by multi-word names (single words like "Mobile" are too often plain words).
function recognisableNames(entity: NamedEntity): string[] {
  const names = [entity.name, ...entity.aliases];
  return entity.kind === "team" ? names.filter((name) => name.includes(" ")) : names;
}

export function checkAnswer(answer: Answer, packet: EvidencePacket, registry: NamedEntity[]): string[] {
  const failures: string[] = [];
  const facts = new Map(packet.facts.map((fact) => [fact.fact_id, fact]));
  const citations = new Set(packet.citations.map((citation) => citation.citation_id));
  const allChoices = [...new Set(packet.facts.flatMap((fact) => fact.choices))];
  const asOfDate = packet.as_of.slice(0, 10);

  if (!answer.items.length) failures.push("the answer has no items");

  answer.items.forEach((item, index) => {
    const label = `item ${index + 1}`;
    const itemFacts = item.fact_ids.map((id) => facts.get(id)).filter((fact): fact is PacketFact => Boolean(fact));
    // 1. Everything cited exists in the packet.
    for (const id of item.fact_ids) if (!facts.has(id)) failures.push(`${label} states fact ${id}, which is not in the packet`);
    for (const id of item.citation_ids) if (!citations.has(id)) failures.push(`${label} cites ${id}, which is not in the packet`);
    // 4. Every item states facts, and factual items cite evidence.
    if (!item.fact_ids.length) failures.push(`${label} states no packet fact`);
    const supporting = new Set(itemFacts.flatMap((fact) => fact.citation_ids));
    if (supporting.size && !item.citation_ids.length) failures.push(`${label} makes a factual statement without citations`);
    // 2. Citations must support the facts the item states.
    for (const id of item.citation_ids) {
      if (citations.has(id) && !supporting.has(id)) failures.push(`${label} cites ${id}, which does not support the facts it states`);
    }

    // 3. Names, choices, and dates must come from the item's own facts (fields or summaries).
    const allowedText = itemFacts.map((fact) => fact.summary).join(" ");
    const allowedIds = new Set(itemFacts.flatMap((fact) => fact.entities.map((entity) => entity.id)));
    for (const entity of registry) {
      for (const name of recognisableNames(entity)) {
        if (mentions(item.text, name) && !allowedIds.has(entity.id) && !mentions(allowedText, name)) {
          failures.push(`${label} names ${name}, who is not in the facts it states`);
          break;
        }
      }
    }
    const allowedChoices = new Set(itemFacts.flatMap((fact) => fact.choices));
    for (const choice of allChoices) {
      if (mentions(item.text, choice) && !allowedChoices.has(choice) && !mentions(allowedText, choice)) failures.push(`${label} mentions ${choice}, which is not in the facts it states`);
    }
    const allowedDates = new Set([...itemFacts.flatMap((fact) => fact.dates), ...datesIn(allowedText), asOfDate]);
    const allowedShort = new Set([...allowedDates].map((date) => (date.length === 10 ? date.slice(5) : date)));
    for (const date of datesIn(item.text)) {
      const ok = date.length === 10 ? allowedDates.has(date) : allowedShort.has(date);
      if (!ok) failures.push(`${label} gives the date ${date}, which is not in the facts it states`);
    }

    // 5. Unknown fields stay unknown.
    for (const fact of itemFacts) {
      if (fact.unknown.includes("rationale") && CAUSAL.test(item.text) && !NOT_RECORDED.test(item.text)) {
        failures.push(`${label} gives a reason for a decision whose rationale is not recorded`);
      }
      if (fact.unknown.includes("decided_by") && DECIDER.test(item.text) && !NOT_RECORDED.test(item.text)) {
        failures.push(`${label} names who decided, which is not recorded`);
      }
    }
  });

  // 5. A conflict is never stated one-sided.
  const groups = new Map<string, string[]>();
  for (const fact of packet.facts) if (fact.conflict_group) groups.set(fact.conflict_group, [...(groups.get(fact.conflict_group) ?? []), fact.fact_id]);
  answer.items.forEach((item, index) => {
    for (const [group, members] of groups) {
      const stated = members.filter((id) => item.fact_ids.includes(id));
      if (stated.length && stated.length < members.length) failures.push(`item ${index + 1} states one side of a conflict (${group}) without the others`);
    }
  });

  // 4. Every main fact is covered by some item.
  const covered = new Set(answer.items.flatMap((item) => item.fact_ids));
  for (const fact of packet.facts) {
    if (MAIN_FACT_KINDS.includes(fact.kind) && !covered.has(fact.fact_id)) failures.push(`fact ${fact.fact_id} (${fact.kind}) is not covered by any item`);
  }
  return failures;
}
