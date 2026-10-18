"use client";

import { useMemo, useState, type FormEvent } from "react";
import type { PublicAnswer } from "@/answer/public-response";
import { PathGraph } from "@/components/path-graph";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { withName } from "@/components/question-helpers";
import { parseLocalTime } from "@/time/company-time";

export type Example = { question: string; followUp?: boolean };
type Selection = { kind: "item" | "event"; index: number } | null;
type Context = PublicAnswer["context"];

const OUTCOME: Record<PublicAnswer["outcome"], { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  answered: { label: "Answered", variant: "default" },
  partial: { label: "Partly answered", variant: "secondary" },
  needs_clarification: { label: "Needs clarification", variant: "outline" },
  conflicting_evidence: { label: "Conflicting evidence", variant: "destructive" },
  insufficient_evidence: { label: "Insufficient evidence", variant: "secondary" },
  unavailable: { label: "Unavailable", variant: "destructive" },
};

export function QuestionApp({ examples, today, timezone }: { examples: Example[]; today: string; timezone: string }) {
  const [question, setQuestion] = useState("");
  const [asOfDate, setAsOfDate] = useState(today);
  const [context, setContext] = useState<Context>(null);
  const [answer, setAnswer] = useState<PublicAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);

  async function ask(text: string, withContext: Context) {
    if (text.trim().length < 3 || loading) return;
    setLoading(true);
    setError(null);
    setSelection(null);
    try {
      // Noon in the company timezone: a whole day's state without DST edge cases.
      const asOf = asOfDate ? parseLocalTime(`${asOfDate}T12:00`, timezone).utc : undefined;
      const response = await fetch("/api/question", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: text, ...(asOf ? { as_of: asOf } : {}), ...(withContext ? { context: withContext } : {}) }),
      });
      const body = (await response.json().catch(() => null)) as (PublicAnswer & { error?: string; issues?: string[] }) | null;
      if (!response.ok || !body || body.error) {
        setError([body?.error ?? `Request failed (${response.status})`, ...(body?.issues ?? [])].join(": "));
        return;
      }
      setAnswer(body);
      setContext(body.context);
    } catch {
      setError("The server could not be reached.");
    } finally {
      setLoading(false);
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void ask(question, context);
  };

  const selected = useMemo(() => {
    if (!answer || !selection) return null;
    const entry = selection.kind === "item" ? answer.answer?.items[selection.index] : answer.timeline[selection.index];
    return entry ? { citations: new Set(entry.citation_ids), edges: new Set(entry.edge_ids) } : null;
  }, [answer, selection]);

  const toggle = (next: NonNullable<Selection>) =>
    setSelection((current) => (current?.kind === next.kind && current.index === next.index ? null : next));

  const projectName = (id: string) => answer?.nodes.find((node) => node.id === id)?.label ?? id;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Ask about decisions and ownership</CardTitle>
            <CardDescription>Answers come only from reviewed records, with the sources that support them.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <form onSubmit={submit} className="space-y-3">
              <Textarea
                aria-label="Question"
                value={question}
                maxLength={500}
                placeholder="Who owns the Atlas migration today?"
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) submit(event);
                }}
              />
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  As of
                  <input
                    type="date"
                    aria-label="As of date"
                    value={asOfDate}
                    onChange={(event) => setAsOfDate(event.target.value)}
                    className="h-9 rounded-md border bg-transparent px-2 text-sm text-foreground"
                  />
                </label>
                {context ? (
                  <Badge variant="outline" className="gap-1" data-testid="context-chip">
                    Follow-up to {projectName(context.project)}
                    {context.topic ? ` · ${context.topic}` : ""}
                    <button type="button" aria-label="Clear follow-up context" className="ml-1 cursor-pointer" onClick={() => setContext(null)}>
                      ×
                    </button>
                  </Badge>
                ) : null}
                <Button type="submit" className="ml-auto" disabled={loading || question.trim().length < 3}>
                  {loading ? "Checking the records…" : "Ask"}
                </Button>
              </div>
            </form>
            <div className="flex flex-wrap gap-2">
              {examples.map((example) => (
                <Button
                  key={example.question}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-auto max-w-full whitespace-normal py-1 text-left"
                  disabled={loading}
                  onClick={() => {
                    setQuestion(example.question);
                    const next = example.followUp ? context : null;
                    if (!example.followUp) setContext(null);
                    void ask(example.question, next);
                  }}
                >
                  {example.question}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>

        {error ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>Could not answer</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {answer ? (
          <Card data-testid="answer">
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={OUTCOME[answer.outcome].variant} data-testid="outcome">
                  {OUTCOME[answer.outcome].label}
                </Badge>
                {answer.answer?.source === "deterministic" ? <Badge variant="outline">Verified fallback wording</Badge> : null}
                <span className="text-xs text-muted-foreground">
                  as of {answer.as_of.slice(0, 10)}
                  {answer.build_id ? ` · build ${answer.build_id}` : ""}
                </span>
              </div>
              <CardDescription>{answer.question}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {answer.clarification ? (
                <div className="space-y-2" data-testid="clarification">
                  <p>{answer.clarification.question}</p>
                  <div className="flex flex-wrap gap-2">
                    {answer.clarification.candidates.map((candidate) => (
                      <Button
                        key={candidate.id}
                        variant="secondary"
                        size="sm"
                        disabled={loading}
                        onClick={() => {
                          if (candidate.kind === "topic") {
                            const [project = "", topic = null] = candidate.id.split("/");
                            void ask(answer.question, { project, topic });
                          } else {
                            const next = withName(answer.question, candidate.name);
                            setQuestion(next);
                            void ask(next, null);
                          }
                        }}
                      >
                        {candidate.name}
                      </Button>
                    ))}
                  </div>
                </div>
              ) : null}

              {answer.answer?.items.length ? (
                <ol className="space-y-2">
                  {answer.answer.items.map((item, index) => {
                    const active = selection?.kind === "item" && selection.index === index;
                    return (
                      <li key={index}>
                        <button
                          type="button"
                          data-testid="answer-item"
                          aria-pressed={active}
                          onClick={() => toggle({ kind: "item", index })}
                          className={`w-full cursor-pointer rounded-md border p-3 text-left transition-colors hover:bg-accent ${active ? "border-highlight bg-accent" : ""}`}
                        >
                          <span>{item.text}</span>
                          <span className="ml-2 inline-flex gap-1 align-middle">
                            {item.citation_ids.map((id) => (
                              <Badge key={id} variant="outline" className="px-1 py-0 text-[10px]">
                                {id}
                              </Badge>
                            ))}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              ) : null}

              {answer.incomplete.truncated || answer.incomplete.missing.length || answer.incomplete.conflicts.length || answer.notes.length ? (
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground" data-testid="notes">
                  {answer.incomplete.conflicts.map((note) => (
                    <li key={`c-${note}`}>Conflict: {note}</li>
                  ))}
                  {answer.incomplete.missing.map((note) => (
                    <li key={`m-${note}`}>{note}</li>
                  ))}
                  {answer.notes.map((note) => (
                    <li key={`n-${note}`}>{note}</li>
                  ))}
                  {answer.incomplete.truncated ? <li>Some records were left out to keep the answer bounded.</li> : null}
                </ul>
              ) : null}
            </CardContent>
          </Card>
        ) : null}

        {answer?.timeline.length ? (
          <Card data-testid="timeline">
            <CardHeader>
              <CardTitle>Timeline</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="relative space-y-4 border-l pl-6">
                {answer.timeline.map((event, index) => {
                  const active = selection?.kind === "event" && selection.index === index;
                  return (
                    <li key={index} className="relative">
                      <span className={`absolute -left-[1.85rem] top-1.5 size-3 rounded-full border-2 bg-background ${active ? "border-highlight" : "border-muted-foreground"}`} />
                      <button type="button" aria-pressed={active} onClick={() => toggle({ kind: "event", index })} className="cursor-pointer text-left">
                        <div className="text-xs font-medium text-muted-foreground">{event.date}</div>
                        <div className={active ? "font-medium" : ""}>{event.text}</div>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </CardContent>
          </Card>
        ) : null}
      </div>

      <div className="space-y-6">
        {answer ? (
          <Card data-testid="evidence">
            <CardHeader>
              <CardTitle>Evidence</CardTitle>
              <CardDescription>{selected ? "Sources for the selected item are highlighted." : "Select an answer item or timeline event to highlight its sources."}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {answer.citations.length ? (
                answer.citations.map((citation) => {
                  const on = selected?.citations.has(citation.citation_id) ?? false;
                  return (
                    <div
                      key={citation.citation_id}
                      data-testid="citation"
                      data-highlighted={on}
                      className={`rounded-md border p-3 text-sm transition-opacity ${on ? "border-highlight" : ""} ${selected && !on ? "opacity-40" : ""}`}
                    >
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className="px-1 py-0 text-[10px]">
                          {citation.citation_id}
                        </Badge>
                        <span className="font-medium">{citation.title}</span>
                        <span className="text-xs text-muted-foreground">
                          {citation.document_id} · {citation.role}
                        </span>
                      </div>
                      <blockquote className="border-l-2 pl-3 text-muted-foreground">{citation.excerpt}</blockquote>
                    </div>
                  );
                })
              ) : (
                <p className="text-sm text-muted-foreground">No source evidence for this answer.</p>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">Evidence and graph paths appear here after a question.</CardContent>
          </Card>
        )}
      </div>

      {answer ? (
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Graph paths</CardTitle>
            <CardDescription>The graph edges that supplied these facts: subjects, claims, source passages, and document versions.</CardDescription>
          </CardHeader>
          <CardContent>
            <PathGraph answer={answer} highlighted={selected?.edges ?? null} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
