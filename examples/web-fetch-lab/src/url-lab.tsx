import { useMemo, useState } from "react";
import type { StreamOptions } from "agents/client";
import type { FormEvent, ReactNode } from "react";
import {
  renderWebFetchPage,
  windowWebFetchPage,
  type WebFetchFormat,
  type WebFetchPage
} from "agents/webfetch";
import { Badge, Button, Input, Select } from "@cloudflare/kumo";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CircleNotchIcon
} from "@phosphor-icons/react";
import {
  CloseSidebarButton,
  SidebarBody,
  SidebarSection,
  WithSidebar
} from "./layout";
import { SettingsPanel } from "./settings";
import {
  isWebFetchFormat,
  type FetchUrlArgs,
  type FetchUrlResult,
  type LabSettings
} from "./shared";

/** Calls a `@callable` method on the agent (`agent.call` from `useAgent`). */
export type CallAgent = (
  method: string,
  args?: unknown[],
  options?: StreamOptions
) => Promise<unknown>;

const SAMPLES = [
  "https://developers.cloudflare.com/agents/",
  "https://en.wikipedia.org/wiki/Cloudflare",
  "https://api.github.com/repos/cloudflare/agents",
  "https://arxiv.org/pdf/1706.03762",
  "http://cloudflare.com/",
  "https://github.com/cloudflare/does-not-exist-xyz",
  "http://169.254.169.254/latest/meta-data"
];

/** How much of the content the raw JSON disclosure shows. */
const RAW_CONTENT_CHARS = 2_000;

const REASONS: Record<number, string> = {
  200: "OK",
  201: "Created",
  203: "Non-Authoritative Information",
  204: "No Content",
  206: "Partial Content",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  410: "Gone",
  429: "Too Many Requests",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout"
};

export function statusText(status: number | undefined): string {
  if (status === undefined) return "—";
  const reason = REASONS[status];
  return reason ? `${status} ${reason}` : String(status);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function UrlLab({
  call,
  settings,
  disabled,
  onSettingsChange
}: {
  call: CallAgent;
  settings: LabSettings;
  disabled: boolean;
  onSettingsChange: (settings: LabSettings) => void;
}) {
  const [url, setUrl] = useState(SAMPLES[0]);
  const [format, setFormat] = useState<WebFetchFormat>(settings.format);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<FetchUrlResult | null>(null);
  const [callError, setCallError] = useState<string | null>(null);

  async function run(args: FetchUrlArgs) {
    setLoading(true);
    setCallError(null);
    try {
      setResult((await call("fetchUrl", [args])) as FetchUrlResult);
    } catch (error) {
      setResult(null);
      setCallError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (url.trim()) void run({ url: url.trim(), format, offset });
  }

  return (
    <WithSidebar
      label="URL Lab info"
      sidebar={({ onClose }) => (
        <UrlLabSidebar
          settings={settings}
          disabled={disabled}
          onSettingsChange={onSettingsChange}
          onPickSample={setUrl}
          onClose={onClose}
        />
      )}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 pt-2 sm:p-6 sm:pt-2">
          <form
            onSubmit={onSubmit}
            className="grid grid-cols-1 gap-3 rounded-xl bg-kumo-base p-4 ring-1 ring-kumo-line sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:items-end"
          >
            <Input
              label="URL"
              value={url}
              placeholder="https://example.com/"
              onChange={(event) => setUrl(event.target.value)}
            />
            <div className="flex flex-col gap-1">
              <span id="lab-format" className="text-sm text-kumo-default">
                Format
              </span>
              <Select
                aria-labelledby="lab-format"
                className="w-24"
                value={format}
                items={[
                  { value: "auto", label: "auto" },
                  { value: "raw", label: "raw" }
                ]}
                onValueChange={(value) => {
                  if (isWebFetchFormat(value)) setFormat(value);
                }}
              />
            </div>
            <Input
              label="Offset"
              type="number"
              min={0}
              className="w-28"
              value={offset}
              onChange={(event) =>
                setOffset(Math.max(0, Math.trunc(Number(event.target.value))))
              }
            />
            <Button
              type="submit"
              variant="primary"
              className="shrink-0"
              disabled={disabled || loading || !url.trim()}
              icon={
                loading ? (
                  <CircleNotchIcon size={14} className="animate-spin" />
                ) : undefined
              }
            >
              Fetch
            </Button>
          </form>

          {callError && (
            <p role="alert" className="text-sm text-kumo-danger">
              {callError}
            </p>
          )}
          {result && !result.ok && <FailureView result={result} />}
          {result?.ok && (
            // Remount on each fetch so paging starts at the new window.
            <OutputView
              key={`${result.page.finalUrl}:${result.offset}:${result.ms}`}
              output={result.page}
              offset={result.offset}
              pageChars={result.pageChars}
              ms={result.ms}
            />
          )}
        </div>
      </div>
    </WithSidebar>
  );
}

function UrlLabSidebar({
  settings,
  disabled,
  onSettingsChange,
  onPickSample,
  onClose
}: {
  settings: LabSettings;
  disabled: boolean;
  onSettingsChange: (settings: LabSettings) => void;
  onPickSample: (url: string) => void;
  onClose?: () => void;
}) {
  const [popupContainer, setPopupContainer] = useState<HTMLElement | null>(
    null
  );
  return (
    <SidebarBody containerRef={setPopupContainer}>
      <SidebarSection
        title="About URL Lab"
        action={<CloseSidebarButton onClose={onClose} />}
      >
        <p className="text-sm leading-relaxed text-kumo-default">
          Fetch one URL through <code>fetchWeb()</code> from{" "}
          <code>agents/webfetch</code>, no model involved, and see every stage:
          redirects, content type, how it was converted, and the exact text the
          model would read.
        </p>
        <p className="text-sm leading-relaxed text-kumo-subtle">
          <strong>Format</strong> <code>auto</code> converts HTML and documents
          to Markdown and pretty-prints JSON; <code>raw</code> returns textual
          bodies as served. <strong>Offset</strong> starts the window partway
          through, the way the model pages a long document.
        </p>
      </SidebarSection>
      <SidebarSection title="Samples">
        <ul className="flex flex-col gap-1">
          {SAMPLES.map((sample) => (
            <li key={sample}>
              <button
                type="button"
                onClick={() => onPickSample(sample)}
                className="w-full truncate rounded-md px-2 py-1 text-left font-mono text-xs text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
                title={sample}
              >
                {sample.replace(/^https?:\/\//, "")}
              </button>
            </li>
          ))}
        </ul>
      </SidebarSection>
      <SidebarSection title="Fetch settings">
        <SettingsPanel
          settings={settings}
          disabled={disabled}
          onChange={onSettingsChange}
          popupContainer={popupContainer}
        />
        <p className="text-xs leading-relaxed text-kumo-inactive">
          Shared with the Chat tab; stored in the agent&apos;s state.
        </p>
      </SidebarSection>
    </SidebarBody>
  );
}

function FailureView({
  result
}: {
  result: Extract<FetchUrlResult, { ok: false }>;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-xl bg-kumo-base p-4 ring-1 ring-kumo-line"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="destructive">{result.code}</Badge>
        <span className="text-sm text-kumo-subtle">
          {statusText(result.status)} · {result.ms} ms ·{" "}
          {result.retryable ? "retryable" : "not retryable"}
        </span>
      </div>
      <pre className="font-mono text-sm whitespace-pre-wrap text-kumo-danger">
        {result.message}
      </pre>
      <Facts
        rows={[
          ["URL", result.url],
          ["Content type", result.contentType]
        ]}
      />
    </div>
  );
}

function OutputView({
  output,
  offset: firstOffset,
  pageChars,
  ms
}: {
  output: WebFetchPage;
  offset: number;
  pageChars: number;
  ms: number;
}) {
  // Page locally: the page holds the whole content, and each window is cut
  // and rendered exactly as the tool cuts and renders it. (The model pages
  // by calling `web_fetch` again with the next offset.)
  const [starts, setStarts] = useState<number[]>([firstOffset]);
  const offset = starts[starts.length - 1];
  const shown = useMemo(
    () => windowWebFetchPage(output, { offset, pageChars }),
    [output, offset, pageChars]
  );
  const text = renderWebFetchPage(shown);
  const { nextOffset } = shown;
  const raw = useMemo(() => {
    const truncated =
      output.content.length > RAW_CONTENT_CHARS
        ? `${output.content.slice(0, RAW_CONTENT_CHARS)}… [${output.content.length - RAW_CONTENT_CHARS} more chars]`
        : output.content;
    return JSON.stringify({ ...output, content: truncated }, null, 2);
  }, [output]);

  const redirectChain =
    output.redirects.length === 0 ? (
      "none"
    ) : (
      <ol className="flex flex-col gap-0.5">
        {[...output.redirects, output.finalUrl].map((hop, index) => (
          <li key={`${index}:${hop}`}>
            {index > 0 && "→ "}
            {hop}
          </li>
        ))}
      </ol>
    );
  const keptHeaders =
    Object.keys(output.headers).length === 0 ? (
      "none kept"
    ) : (
      <dl className="grid grid-cols-[auto_1fr] gap-x-3">
        {Object.entries(output.headers).map(([name, value]) => (
          <div key={name} className="contents">
            <dt className="text-kumo-inactive">{name}</dt>
            <dd className="break-all">{value}</dd>
          </div>
        ))}
      </dl>
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-xl bg-kumo-base p-4 ring-1 ring-kumo-line">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={output.status >= 400 ? "destructive" : "primary"}>
            {statusText(output.status)}
          </Badge>
          <Badge variant="outline">via {output.via}</Badge>
          <span className="text-sm text-kumo-subtle">{ms} ms</span>
        </div>
        <Facts
          rows={[
            ["Title", output.title],
            ["Requested", output.url],
            ["Redirects", redirectChain],
            ["Final URL", output.finalUrl],
            ["Content type", output.contentType || "unknown"],
            ["Bytes in", formatBytes(output.bytes)],
            ["Chars out", output.totalChars.toLocaleString()],
            ["Headers", keptHeaders]
          ]}
        />
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xs font-medium tracking-wide text-kumo-subtle uppercase">
            What the model reads
          </h2>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="secondary"
              icon={<ArrowLeftIcon size={14} />}
              disabled={starts.length <= 1}
              onClick={() => setStarts((all) => all.slice(0, -1))}
            >
              Prev
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={nextOffset === null}
              onClick={() => {
                if (nextOffset !== null)
                  setStarts((all) => [...all, nextOffset]);
              }}
            >
              Next <ArrowRightIcon size={14} />
            </Button>
          </div>
        </div>
        <pre className="max-h-[32rem] overflow-auto rounded-lg bg-kumo-recessed p-3 font-mono text-xs break-words whitespace-pre-wrap text-kumo-default">
          {text}
        </pre>
      </div>

      <details className="rounded-xl bg-kumo-base p-4 ring-1 ring-kumo-line">
        <summary className="cursor-pointer text-sm text-kumo-default">
          Raw output JSON (content truncated to{" "}
          {RAW_CONTENT_CHARS.toLocaleString()} chars)
        </summary>
        <pre className="mt-3 max-h-96 overflow-auto font-mono text-xs break-all whitespace-pre-wrap text-kumo-subtle">
          {raw}
        </pre>
      </details>
    </div>
  );
}

function Facts({ rows }: { rows: [string, ReactNode | undefined][] }) {
  return (
    <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1.5 text-sm">
      {rows
        .filter(([, value]) => value !== undefined && value !== "")
        .map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-kumo-inactive">{label}</dt>
            <dd className="min-w-0 font-mono text-xs break-all text-kumo-default">
              {value}
            </dd>
          </div>
        ))}
    </dl>
  );
}
