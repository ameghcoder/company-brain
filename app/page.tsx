import { DEFAULT_FIXTURE_ROOT } from "@/ingest/load";
import { loadManifest } from "@/ingest/manifest";
import { QuestionApp, type Example } from "@/components/question-app";
import { localDateString } from "@/time/company-time";

export const dynamic = "force-dynamic";

const EXAMPLES: Example[] = [
  { question: "What changed in the Atlas project's payments provider this month?" },
  { question: "Why did the team replace the earlier provider decision, and where was that decided?", followUp: true },
  { question: "Who owns the Atlas migration today, and who owned it before October 15?" },
  { question: "Show the Atlas decision and ownership timeline with evidence." },
  { question: "What was decided about the CRM vendor?" },
  { question: "What did Atlas decide about chargebacks?" },
  { question: "What did Alex decide?" },
];

export default async function HomePage() {
  const { company } = await loadManifest(DEFAULT_FIXTURE_ROOT);
  return (
    <main className="mx-auto max-w-7xl space-y-6 px-4 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Company Brain</h1>
        <p className="text-muted-foreground">
          Evidence-backed answers about what changed, why it was decided, and who owns it, for {company.name} (synthetic demo data, read-only).
        </p>
      </header>
      <QuestionApp examples={EXAMPLES} today={localDateString(new Date(), company.timezone)} timezone={company.timezone} />
    </main>
  );
}
