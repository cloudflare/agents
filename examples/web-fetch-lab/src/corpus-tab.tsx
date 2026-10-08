import { Fragment, useMemo, useState } from "react";
import { Badge, Button, Switch, Table } from "@cloudflare/kumo";
import {
  CaretRightIcon,
  CircleNotchIcon,
  PlayIcon
} from "@phosphor-icons/react";
import { CORPUS, type CorpusEntry, type CorpusExpectation } from "./corpus";
import {
  CloseSidebarButton,
  SidebarBody,
  SidebarSection,
  WithSidebar
} from "./layout";
import type { CorpusResult, CorpusSummary } from "./shared";
import { statusText, type CallAgent } from "./url-lab";

/** The expectation as one compact line. */
function describeExpectation(expect: CorpusExpectation): string {
  if (expect.errorCode) return expect.errorCode;
  const parts: string[] = [];
  if (expect.status !== undefined) parts.push(String(expect.status));
  if (expect.via) parts.push(expect.via);
  if (expect.minChars !== undefined)
    parts.push(`≥${expect.minChars.toLocaleString()} ch`);
  if (expect.maxChars !== undefined)
    parts.push(`≤${expect.maxChars.toLocaleString()} ch`);
  if (expect.minRedirects !== undefined)
    parts.push(`≥${expect.minRedirects} redirect`);
  if (expect.finalUrlIncludes) parts.push(`→ …${expect.finalUrlIncludes}…`);
  if (expect.contentIncludes) parts.push(`has “${expect.contentIncludes}”`);
  for (const [name, value] of Object.entries(expect.headers ?? {})) {
    parts.push(`${name}: ${value}`);
  }
  return parts.join(" · ") || "any success";
}

function describeActual(result: CorpusResult): string {
  const { actual } = result;
  if (actual.errorCode) return actual.errorCode;
  return [
    statusText(actual.status),
    actual.via,
    `${(actual.chars ?? 0).toLocaleString()} ch`,
    actual.redirects?.length ? `${actual.redirects.length} redirect` : ""
  ]
    .filter(Boolean)
    .join(" · ");
}

const CONFIDENCE_VARIANT = {
  high: "green",
  medium: "orange",
  low: "red"
} as const;

/** What each confidence level means, for the badge tooltip and the legend. */
const CONFIDENCE_MEANING: Record<CorpusEntry["confidence"], string> = {
  high: "Stable site, deterministic answer: Cloudflare docs, example.com, RFCs, GitHub, Wikipedia, raw files, and every URL-policy rejection. A failure here is a bug in web_fetch.",
  medium:
    "Should hold, but depends on something outside the tool: a site that may challenge Workers egress (npm, Stack Overflow), a third-party helper (httpbin, münchen.de), a conversion threshold (PDF, docx), or a page that changes often (BBC, YouTube). Read the detail before calling it a bug.",
  low: "Known to block or rate-limit datacenter IPs: Hacker News, Reddit, Substack, 'enable JS' pages. The row exists to show what the model would see; a failure is information about the site, not about the tool."
};

export function CorpusTab({
  call,
  disabled
}: {
  call: CallAgent;
  disabled: boolean;
}) {
  const [results, setResults] = useState<Record<string, CorpusResult>>({});
  // What the current run is working through, in order.
  const [queue, setQueue] = useState<string[]>([]);
  const [summary, setSummary] = useState<CorpusSummary | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [failuresOnly, setFailuresOnly] = useState(false);

  const running = queue.length > 0;
  const current = queue.find((id) => !(id in results));
  const finished = queue.filter((id) => id in results).length;

  function run(entries: CorpusEntry[]) {
    const ids = entries.map((entry) => entry.id);
    setRunError(null);
    setSummary(null);
    // Clear the results being re-run so progress shows.
    setResults((all) => {
      const next = { ...all };
      for (const id of ids) delete next[id];
      return next;
    });
    setQueue(ids);
    call("runCorpus", entries.length === CORPUS.length ? [] : [ids], {
      onChunk: (chunk) => {
        const result = chunk as CorpusResult;
        setResults((all) => ({ ...all, [result.id]: result }));
      },
      onDone: (final) => {
        // A single-entry run's summary isn't interesting; keep the last full one.
        if (entries.length > 1) setSummary(final as CorpusSummary);
        setQueue([]);
      },
      onError: (error) => {
        setRunError(error);
        setQueue([]);
      }
    }).catch((error: unknown) => {
      setRunError(error instanceof Error ? error.message : String(error));
      setQueue([]);
    });
  }

  const totals = useMemo(() => {
    const done = Object.values(results);
    const passed = done.filter((result) => result.pass).length;
    return {
      passed,
      failed: done.length - passed,
      notRun: CORPUS.length - done.length,
      ms: done.reduce((sum, result) => sum + result.ms, 0)
    };
  }, [results]);

  const rows = failuresOnly
    ? CORPUS.filter((entry) => results[entry.id]?.pass === false)
    : CORPUS;

  return (
    <WithSidebar
      label="Corpus info"
      sidebar={({ onClose }) => <CorpusSidebar onClose={onClose} />}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 pt-2 sm:p-6 sm:pt-2">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              disabled={disabled || running}
              icon={
                running ? (
                  <CircleNotchIcon size={14} className="animate-spin" />
                ) : (
                  <PlayIcon size={14} />
                )
              }
              onClick={() => run(CORPUS)}
            >
              {running
                ? `Running ${Math.min(queue.length, finished + 1)}/${queue.length}…`
                : "Run all"}
            </Button>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="green">{totals.passed} passed</Badge>
              <Badge variant="red">{totals.failed} failed</Badge>
              <Badge variant="neutral">{totals.notRun} not run</Badge>
              <span className="text-kumo-subtle">
                {(totals.ms / 1000).toFixed(1)} s fetching
                {summary &&
                  ` · last full run ${(summary.ms / 1000).toFixed(1)} s`}
              </span>
            </div>
            <div className="ml-auto">
              <Switch
                label="Failures only"
                controlFirst={false}
                size="sm"
                checked={failuresOnly}
                onCheckedChange={setFailuresOnly}
              />
            </div>
          </div>

          {runError && (
            <p role="alert" className="text-sm text-kumo-danger">
              {runError}
            </p>
          )}

          <div className="overflow-x-auto rounded-xl ring-1 ring-kumo-line">
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Entry</Table.Head>
                  <Table.Head>Expected</Table.Head>
                  <Table.Head>Actual</Table.Head>
                  <Table.Head className="text-right">ms</Table.Head>
                  <Table.Head>Result</Table.Head>
                  <Table.Head>
                    <span className="sr-only">Actions</span>
                  </Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((entry) => {
                  const result = results[entry.id];
                  const isOpen = expanded === entry.id;
                  return (
                    <Fragment key={entry.id}>
                      <Table.Row>
                        <Table.Cell>
                          <div className="flex max-w-xs flex-col gap-0.5">
                            <span className="flex items-center gap-1.5">
                              <span className="font-mono text-xs font-medium text-kumo-default">
                                {entry.id}
                              </span>
                              <span
                                title={CONFIDENCE_MEANING[entry.confidence]}
                              >
                                <Badge
                                  variant={CONFIDENCE_VARIANT[entry.confidence]}
                                >
                                  {entry.confidence}
                                </Badge>
                              </span>
                              {entry.format === "raw" && (
                                <Badge variant="outline">raw</Badge>
                              )}
                            </span>
                            <span
                              className="truncate font-mono text-xs text-kumo-inactive"
                              title={entry.url}
                            >
                              {entry.url}
                            </span>
                          </div>
                        </Table.Cell>
                        <Table.Cell>
                          <span className="font-mono text-xs text-kumo-subtle">
                            {describeExpectation(entry.expect)}
                          </span>
                        </Table.Cell>
                        <Table.Cell>
                          <span className="font-mono text-xs text-kumo-default">
                            {result ? describeActual(result) : ""}
                          </span>
                        </Table.Cell>
                        <Table.Cell className="text-right">
                          <span className="font-mono text-xs text-kumo-subtle tabular-nums">
                            {result?.ms ?? ""}
                          </span>
                        </Table.Cell>
                        <Table.Cell>
                          {result ? (
                            <Badge variant={result.pass ? "green" : "red"}>
                              {result.pass ? "pass" : "fail"}
                            </Badge>
                          ) : current === entry.id ? (
                            <CircleNotchIcon
                              size={14}
                              className="animate-spin text-kumo-subtle"
                              aria-label="Running"
                            />
                          ) : null}
                        </Table.Cell>
                        <Table.Cell>
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={disabled || running}
                              onClick={() => run([entry])}
                            >
                              Run
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              shape="square"
                              aria-label={
                                isOpen ? "Hide details" : "Show details"
                              }
                              aria-expanded={isOpen}
                              icon={
                                <CaretRightIcon
                                  size={12}
                                  className={isOpen ? "rotate-90" : undefined}
                                />
                              }
                              onClick={() =>
                                setExpanded(isOpen ? null : entry.id)
                              }
                            />
                          </div>
                        </Table.Cell>
                      </Table.Row>
                      {isOpen && (
                        <Table.Row>
                          <Table.Cell colSpan={6}>
                            <EntryDetail entry={entry} result={result} />
                          </Table.Cell>
                        </Table.Row>
                      )}
                    </Fragment>
                  );
                })}
              </Table.Body>
            </Table>
          </div>
        </div>
      </div>
    </WithSidebar>
  );
}

function CorpusSidebar({ onClose }: { onClose?: () => void }) {
  return (
    <SidebarBody>
      <SidebarSection
        title="About the corpus"
        action={<CloseSidebarButton onClose={onClose} />}
      >
        <p className="text-sm leading-relaxed text-kumo-default">
          {CORPUS.length} URLs from <code>src/corpus.ts</code>, each with what
          we expect <code>web_fetch</code> to do: Markdown for Agents, HTML
          conversion, JSON, text, PDFs and documents, redirects, error pages,
          size limits, bot challenges, and every URL-policy rejection.
        </p>
        <p className="text-sm leading-relaxed text-kumo-subtle">
          They run one at a time on the agent against the live web, with the
          default settings, and stream back as they finish. Open a row for the
          note, the failures, and the first few hundred characters fetched.
        </p>
      </SidebarSection>
      <SidebarSection title="Confidence">
        <p className="text-sm leading-relaxed text-kumo-subtle">
          How sure we are the expectation holds from a Worker on the live web.
          Expectations were checked with curl from a laptop and then against
          Workers egress, which sites often treat differently.
        </p>
        <dl className="flex flex-col gap-3">
          {(["high", "medium", "low"] as const).map((level) => (
            <div key={level} className="flex flex-col gap-1">
              <dt>
                <Badge variant={CONFIDENCE_VARIANT[level]}>{level}</Badge>
              </dt>
              <dd className="text-sm leading-relaxed text-kumo-default">
                {CONFIDENCE_MEANING[level]}
              </dd>
            </div>
          ))}
        </dl>
      </SidebarSection>
    </SidebarBody>
  );
}

function EntryDetail({
  entry,
  result
}: {
  entry: CorpusEntry;
  result: CorpusResult | undefined;
}) {
  return (
    <div className="flex max-w-4xl flex-col gap-2 py-1 text-sm whitespace-normal">
      <p className="text-kumo-subtle">{entry.note}</p>
      <p className="font-mono text-xs break-all text-kumo-inactive">
        {entry.url}
      </p>
      {result && result.failures.length > 0 && (
        <ul className="list-disc pl-5 text-kumo-danger">
          {result.failures.map((failure) => (
            <li key={failure}>{failure}</li>
          ))}
        </ul>
      )}
      {result?.actual.errorMessage && (
        <pre className="font-mono text-xs whitespace-pre-wrap text-kumo-danger">
          {result.actual.errorMessage}
        </pre>
      )}
      {result && (
        <pre className="max-h-64 overflow-auto rounded-lg bg-kumo-recessed p-3 font-mono text-xs break-all whitespace-pre-wrap text-kumo-subtle">
          {JSON.stringify(result.actual, null, 2)}
          {result.preview !== undefined &&
            `\n\n── first ${result.preview.length} chars ──\n${result.preview}`}
        </pre>
      )}
      {!result && <p className="text-kumo-inactive">Not run yet.</p>}
    </div>
  );
}
