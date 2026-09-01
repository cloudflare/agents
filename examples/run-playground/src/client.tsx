import "./styles.css";
import {
  Badge,
  Button,
  PoweredByCloudflare,
  Surface,
  Switch,
  Tabs,
  Text,
  Textarea
} from "@cloudflare/kumo";
import {
  ArrowElbowDownRightIcon,
  MoonIcon,
  PlayIcon,
  SunIcon
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { RunApiResponse } from "./server";

interface Preset {
  id: string;
  label: string;
  note: string;
  source: string;
  limits?: Partial<Limits>;
}

interface Limits {
  timeoutMs: number;
  cpuMs: number;
  maxLogBytes: number;
}

const DEFAULT_LIMITS: Limits = {
  timeoutMs: 30_000,
  cpuMs: 5_000,
  maxLogBytes: 262_144
};

const EXAMPLE_PRESETS: Preset[] = [
  {
    id: "hello",
    label: "Hello TypeScript",
    note: "Types are stripped before execution; console output comes back with the result.",
    source: `interface Pair {
  left: number;
  right: number;
}
const pair: Pair = { left: 20, right: 22 };
console.log("adding", pair.left, pair.right);
return pair.left + pair.right satisfies number;
`
  },
  {
    id: "host-functions",
    label: "Host functions",
    note: "demo.customers() runs in the parent Worker. It is the only authority this code has.",
    source: `const customers = await demo.customers();
const paying = customers.filter((c) => c.plan !== "free");
console.log(\`\${paying.length} of \${customers.length} customers pay\`);
return {
  paying: paying.map((c) => c.name),
  revenue: paying.reduce((sum, c) => sum + c.spend, 0)
};
`
  },
  {
    id: "fresh-isolate",
    label: "Fresh isolate",
    note: "Every run gets a brand-new isolate. Mash Run — this counter can never reach 2.",
    source: `// Global state cannot survive between runs.
globalThis.runCount = (globalThis.runCount ?? 0) + 1;
return globalThis.runCount;
`
  },
  {
    id: "rich-data",
    label: "Rich data",
    note: "Results travel over Workers RPC, so BigInt, Map, Set, and Date survive the trip.",
    source: `const seen = new Map([["bigint", 123n], ["negative zero", -0]]);
return {
  seen,
  tags: new Set(["isolate", "rpc"]),
  at: new Date(0)
};
`
  }
];

const BREAK_PRESETS: Preset[] = [
  {
    id: "cpu-burn",
    label: "Burn CPU",
    note: "Deployed, the platform meters real CPU and kills this with RUN_RESOURCE_LIMIT once cpuMs is spent — but enforcement lags a second or two, and the spinning child freezes the parent's clock, so the reported time underreports for this preset. Local dev does not enforce CPU budgets at all.",
    source: `// Heavy synchronous work against a 500ms CPU budget.
let x = 0;
for (let i = 0; i < 3_000_000_000; i++) {
  x += Math.sqrt(i);
}
return x;
`,
    limits: { cpuMs: 500 }
  },
  {
    id: "fetch",
    label: "Reach the network",
    note: "Outbound access is disabled at the platform level — there is no fetch to monkey-patch back.",
    source: `// The sandbox has no network. This throws.
return await fetch("https://example.com");
`
  },
  {
    id: "import",
    label: "Import a module",
    note: "Imports are rejected before any Worker is even loaded.",
    source: `import { readFileSync } from "node:fs";
return readFileSync("/etc/passwd", "utf8");
`
  },
  {
    id: "throw",
    label: "Throw deep in a call",
    note: "Stacks point at your own source lines. Click a frame to jump to it.",
    source: `function stepOne() {
  return stepTwo();
}
function stepTwo() {
  throw new Error("boom from line 5");
}
return stepOne();
`
  },
  {
    id: "log-flood",
    label: "Flood the logs",
    note: "Console capture is byte-bounded. The flood is cut off with a single truncation warning.",
    source: `for (let i = 0; i < 10_000; i++) {
  console.log("flood", i, "x".repeat(80));
}
return "done logging";
`,
    limits: { maxLogBytes: 2_048 }
  },
  {
    id: "timeout",
    label: "Sleep past the timeout",
    note: "The parent owns a wall-clock timeout for code that waits too long.",
    source: `console.log("napping for a minute…");
await demo.wait(60_000);
return "you should never see this";
`,
    limits: { timeoutMs: 2_000 }
  }
];

const ALL_PRESETS = [...EXAMPLE_PRESETS, ...BREAK_PRESETS];

/** Keep in sync with the hostFunctions passed to run() in server.ts. */
const HOST_FUNCTIONS = [
  {
    signature: "demo.customers()",
    description: "Six demo customer records. Runs in the parent Worker."
  },
  {
    signature: "demo.wait(ms)",
    description: "Signal-aware sleep in the parent; cancellation reaches it."
  }
];

interface RunHistoryEntry {
  durationMs: number;
  ok: boolean;
}

function ModeToggle() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") || "light"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);

  return (
    <Button
      variant="ghost"
      shape="square"
      aria-label="Toggle theme"
      onClick={() => setMode((m) => (m === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

/** Dashboard-style card: bordered surface with a header row and body sections. */
function Card({
  title,
  meta,
  children,
  className
}: {
  title: React.ReactNode;
  meta?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Surface
      className={`rounded-xl ring ring-kumo-line ${className ?? ""}`.trim()}
    >
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-kumo-line px-5 py-3">
        <h2 className="text-sm font-semibold text-kumo-default">{title}</h2>
        {meta !== undefined && (
          <div className="flex items-center gap-3">{meta}</div>
        )}
      </div>
      {children}
    </Surface>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-1.5 text-xs font-medium text-kumo-subtle">{children}</p>
  );
}

function formatMilliseconds(value: number): string {
  return `${value.toLocaleString("en-US")} ms`;
}

function formatBytes(value: number): string {
  return value >= 1024
    ? `${(value / 1024).toLocaleString("en-US")} KiB`
    : `${value.toLocaleString("en-US")} B`;
}

function LimitSlider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="font-mono text-xs text-kumo-subtle">{label}</span>
        <span className="font-mono text-xs font-medium text-kumo-default">
          {format(value)}
        </span>
      </div>
      <input
        type="range"
        aria-label={label}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        className="w-full accent-kumo-brand"
      />
    </div>
  );
}

/** Percentile over an unsorted sample (nearest-rank on a sorted copy). */
function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.floor(fraction * sorted.length)
  );
  return sorted[index] ?? 0;
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="px-5 py-4">
      <Text size="sm" variant="secondary">
        {label}
      </Text>
      <p className="mt-1 text-3xl font-semibold text-kumo-default">{value}</p>
    </div>
  );
}

function MetricsTab({ history }: { history: RunHistoryEntry[] }) {
  const durations = history.map((entry) => entry.durationMs);
  const failures = history.filter((entry) => !entry.ok).length;
  const median = percentile(durations, 0.5);
  const p95 = percentile(durations, 0.95);
  const max = Math.max(...durations, 1);
  const barWidth = 10;
  const gap = 4;
  const height = 96;

  return (
    <Card
      title="Metrics"
      meta={<Badge variant="secondary">This session</Badge>}
    >
      {history.length === 0 ? (
        <div className="px-5 py-8">
          <Text size="sm" variant="secondary">
            No runs yet. Run some code on the Playground tab and the server-side
            duration of each fresh isolate shows up here.
          </Text>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 divide-x divide-kumo-line sm:grid-cols-4">
            <Stat label="Runs" value={history.length} />
            <Stat label="Median" value={`${median} ms`} />
            <Stat label="P95" value={`${p95} ms`} />
            <Stat label="Failures" value={failures} />
          </div>
          <div className="border-t border-kumo-line px-5 py-4">
            <SectionLabel>
              Server-side duration per run — every bar is a brand-new isolate
            </SectionLabel>
            <svg
              aria-label="Run duration history"
              width={history.length * (barWidth + gap)}
              height={height}
              className="max-w-full"
            >
              {history.map((entry, index) => {
                const barHeight = Math.max(
                  4,
                  Math.round((entry.durationMs / max) * (height - 6))
                );
                return (
                  <rect
                    // biome-ignore lint: order is the identity of a history bar
                    key={index}
                    x={index * (barWidth + gap)}
                    y={height - barHeight}
                    width={barWidth}
                    height={barHeight}
                    rx={2}
                    className={
                      entry.ok ? "fill-kumo-brand" : "fill-status-error"
                    }
                  >
                    <title>{`${entry.durationMs}ms${entry.ok ? "" : " (failed)"}`}</title>
                  </rect>
                );
              })}
            </svg>
          </div>
        </>
      )}
    </Card>
  );
}

function AboutTab() {
  return (
    <div className="grid gap-4">
      <Card title="How it works">
        <div className="grid gap-3 px-5 py-4">
          <Text size="sm">
            Everything you type on the Playground tab executes in a brand-new{" "}
            <span className="font-mono text-[0.9em]">Dynamic Worker</span> via{" "}
            <span className="font-mono text-[0.9em]">@cloudflare/run</span> — no
            bindings, no imports, and no network. Its only authority is the{" "}
            <span className="font-mono text-[0.9em]">demo.*</span> host
            functions the server passes in.
          </Text>
          <Text size="sm" variant="secondary">
            Pick a preset — especially the hostile ones — and watch each escape
            attempt come back as a clean, typed RunError with a stable code,
            bounded logs, and a stack that points at your own source lines.
          </Text>
        </div>
      </Card>

      <Card title="Host functions">
        <div>
          {HOST_FUNCTIONS.map((hostFunction) => (
            <div
              key={hostFunction.signature}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-kumo-line px-5 py-3 last:border-b-0"
            >
              <code className="rounded bg-kumo-elevated px-1.5 py-0.5 font-mono text-xs text-kumo-default">
                {hostFunction.signature}
              </code>
              <Text size="sm" variant="secondary">
                {hostFunction.description}
              </Text>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Guarantees">
        <div>
          {[
            [
              "Isolation",
              "Fresh isolate per run, outbound network blocked at the platform, no parent bindings visible."
            ],
            [
              "Limits",
              "Wall timeout, CPU budget, log bytes, host-call counts — all bounded with safe defaults."
            ],
            [
              "Errors",
              "Every failure is one RunError with a stable code; host-side error details never leak into the sandbox."
            ],
            [
              "Data",
              "Results cross over native Workers RPC: BigInt, Map, Set, Date, typed arrays, and cycles survive."
            ]
          ].map(([label, description]) => (
            <div
              key={label}
              className="grid gap-x-6 gap-y-1 border-b border-kumo-line px-5 py-3 last:border-b-0 sm:grid-cols-[8rem_1fr]"
            >
              <Text size="sm" bold>
                {label}
              </Text>
              <Text size="sm" variant="secondary">
                {description}
              </Text>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

const STACK_LINE_PATTERN = /run\.js:(\d+):(\d+)/;

function StackTrace({
  stack,
  onJumpToLine
}: {
  stack: string;
  onJumpToLine: (line: number) => void;
}) {
  return (
    <div className="mt-2">
      {stack.split("\n").map((line, index) => {
        const match = STACK_LINE_PATTERN.exec(line);
        const key = `${index}:${line}`;
        if (match === null) {
          return (
            <pre
              key={key}
              className="font-mono text-xs text-kumo-subtle whitespace-pre-wrap break-words"
            >
              {line}
            </pre>
          );
        }
        const sourceLine = Number(match[1]);
        return (
          <button
            key={key}
            type="button"
            onClick={() => onJumpToLine(sourceLine)}
            title={`Jump to line ${sourceLine}`}
            className="block w-full cursor-pointer rounded px-1 text-left font-mono text-xs text-kumo-brand underline decoration-dotted underline-offset-2 whitespace-pre-wrap break-words hover:bg-kumo-elevated"
          >
            {line}
          </button>
        );
      })}
    </div>
  );
}

const LOG_LEVEL_CLASSES: Record<string, string> = {
  error: "text-status-error",
  warn: "text-status-warning",
  log: "text-kumo-default",
  info: "text-kumo-default",
  debug: "text-kumo-subtle"
};

export function App() {
  const initialPreset = EXAMPLE_PRESETS[0];
  const [tab, setTab] = useState("playground");
  const [source, setSource] = useState(initialPreset?.source ?? "");
  const [presetId, setPresetId] = useState(initialPreset?.id);
  const [limits, setLimits] = useState<Limits>(DEFAULT_LIMITS);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunApiResponse>();
  const [showRaw, setShowRaw] = useState(false);
  const [history, setHistory] = useState<RunHistoryEntry[]>([]);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  const activePreset = ALL_PRESETS.find((preset) => preset.id === presetId);

  function applyPreset(preset: Preset) {
    setPresetId(preset.id);
    setSource(preset.source);
    setLimits({ ...DEFAULT_LIMITS, ...preset.limits });
    setResult(undefined);
  }

  function jumpToLine(line: number) {
    const editor = editorRef.current;
    if (editor === null) return;
    const lines = source.split("\n");
    const start = lines
      .slice(0, line - 1)
      .reduce((offset, text) => offset + text.length + 1, 0);
    const end = start + (lines[line - 1]?.length ?? 0);
    editor.focus();
    editor.setSelectionRange(start, end);
  }

  async function handleRun() {
    setRunning(true);
    setResult(undefined);
    try {
      const response = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, limits })
      });
      const body = (await response.json()) as RunApiResponse;
      setResult(body);
      setHistory((previous) =>
        [...previous, { durationMs: body.durationMs, ok: body.ok }].slice(-30)
      );
    } catch (error: unknown) {
      setResult({
        ok: false,
        code: "NETWORK",
        message: error instanceof Error ? error.message : String(error),
        logs: [],
        durationMs: 0
      });
    } finally {
      setRunning(false);
    }
  }

  function handleEditorKeyDown(
    event: React.KeyboardEvent<HTMLTextAreaElement>
  ) {
    if (event.key !== "Tab") return;
    event.preventDefault();
    const editor = event.currentTarget;
    const { selectionStart, selectionEnd } = editor;
    setSource(
      `${source.slice(0, selectionStart)}  ${source.slice(selectionEnd)}`
    );
    requestAnimationFrame(() => {
      editor.setSelectionRange(selectionStart + 2, selectionStart + 2);
    });
  }

  function renderPresetButtons(presets: Preset[]) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {presets.map((preset) => (
          <Button
            key={preset.id}
            size="sm"
            variant={preset.id === presetId ? "secondary" : "ghost"}
            aria-pressed={preset.id === presetId}
            onClick={() => applyPreset(preset)}
          >
            {preset.label}
          </Button>
        ))}
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-4 px-6 py-5">
      <header className="flex items-center justify-between gap-3">
        <div className="grid gap-0.5">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-kumo-default">
              Run playground
            </h1>
            <Badge variant="secondary">
              <span className="font-mono text-[0.9em]">@cloudflare/run</span>
            </Badge>
          </div>
          <Text size="sm" variant="secondary">
            Untrusted code, fresh isolate per run, authority only through host
            functions.
          </Text>
        </div>
        <ModeToggle />
      </header>

      <Tabs
        tabs={[
          { value: "playground", label: "Playground" },
          { value: "metrics", label: "Metrics" },
          { value: "about", label: "About" }
        ]}
        value={tab}
        onValueChange={setTab}
      />

      {tab === "playground" && (
        <div className="grid flex-1 gap-4">
          <Card
            title="Code"
            meta={
              <Button
                variant="primary"
                size="sm"
                loading={running}
                onClick={handleRun}
                icon={<PlayIcon size={14} weight="fill" />}
              >
                Run
              </Button>
            }
          >
            <div className="grid gap-3 px-5 py-4">
              <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
                <div>
                  <SectionLabel>Examples</SectionLabel>
                  {renderPresetButtons(EXAMPLE_PRESETS)}
                </div>
                <div>
                  <SectionLabel>Try to break it</SectionLabel>
                  {renderPresetButtons(BREAK_PRESETS)}
                </div>
              </div>

              {activePreset !== undefined && (
                <div className="flex items-start gap-1.5 text-kumo-subtle">
                  <span className="h-lh flex items-center">
                    <ArrowElbowDownRightIcon size={14} className="shrink-0" />
                  </span>
                  <Text size="xs" variant="secondary">
                    {activePreset.note}
                  </Text>
                </div>
              )}

              <Textarea
                ref={editorRef}
                value={source}
                onChange={(event) => setSource(event.currentTarget.value)}
                onKeyDown={handleEditorKeyDown}
                spellCheck={false}
                aria-label="Source editor"
                className="min-h-[240px] resize-y font-mono text-[13px]"
              />

              <div className="flex flex-wrap gap-x-6 gap-y-1">
                {HOST_FUNCTIONS.map((hostFunction) => (
                  <div
                    key={hostFunction.signature}
                    className="flex items-baseline gap-2"
                  >
                    <code className="rounded bg-kumo-elevated px-1 font-mono text-xs text-kumo-default">
                      {hostFunction.signature}
                    </code>
                    <Text size="xs" variant="secondary">
                      {hostFunction.description}
                    </Text>
                  </div>
                ))}
              </div>
            </div>

            <div className="border-t border-kumo-line px-5 py-4">
              <SectionLabel>Limits</SectionLabel>
              <div className="grid gap-2.5 sm:grid-cols-3">
                <LimitSlider
                  label="timeoutMs"
                  value={limits.timeoutMs}
                  min={500}
                  max={30_000}
                  step={500}
                  format={formatMilliseconds}
                  onChange={(timeoutMs) =>
                    setLimits((previous) => ({ ...previous, timeoutMs }))
                  }
                />
                <LimitSlider
                  label="cpuMs"
                  value={limits.cpuMs}
                  min={100}
                  max={5_000}
                  step={100}
                  format={formatMilliseconds}
                  onChange={(cpuMs) =>
                    setLimits((previous) => ({ ...previous, cpuMs }))
                  }
                />
                <LimitSlider
                  label="maxLogBytes"
                  value={limits.maxLogBytes}
                  min={1_024}
                  max={262_144}
                  step={1_024}
                  format={formatBytes}
                  onChange={(maxLogBytes) =>
                    setLimits((previous) => ({ ...previous, maxLogBytes }))
                  }
                />
              </div>
            </div>
          </Card>

          <Card
            title="Result"
            meta={
              <>
                {result?.ok === true && (
                  <Switch
                    size="sm"
                    label="Raw"
                    checked={showRaw}
                    onCheckedChange={setShowRaw}
                  />
                )}
                {result !== undefined && (
                  <span
                    className="font-mono text-xs text-kumo-subtle"
                    title="time spent inside run() on the server"
                  >
                    {result.durationMs}ms
                  </span>
                )}
                {result?.ok === true && (
                  <Badge variant="success">completed</Badge>
                )}
                {result?.ok === false && (
                  <Badge variant="destructive">{result.code}</Badge>
                )}
              </>
            }
          >
            <div className="px-5 py-4">
              {result === undefined && !running && (
                <Text size="sm" variant="secondary">
                  Run some code to see its result, logs, and errors here.
                </Text>
              )}
              {running && (
                <Text size="sm" variant="secondary">
                  Loading a fresh isolate…
                </Text>
              )}

              {result?.ok === true && (
                <div>
                  <pre className="rounded-md bg-kumo-elevated p-2.5 font-mono text-xs text-status-success whitespace-pre-wrap break-words">
                    {showRaw ? result.raw : result.value}
                  </pre>
                  {showRaw && (
                    <p className="mt-1.5 font-mono text-xs text-kumo-subtle">
                      The full run result object — status, value, and captured
                      logs.
                    </p>
                  )}
                </div>
              )}

              {result?.ok === false && (
                <div>
                  <pre className="font-mono text-xs text-status-error whitespace-pre-wrap break-words">
                    {result.message}
                  </pre>
                  {result.stack !== undefined && (
                    <StackTrace
                      stack={result.stack}
                      onJumpToLine={jumpToLine}
                    />
                  )}
                </div>
              )}
            </div>

            {result !== undefined && result.logs.length > 0 && !showRaw && (
              <div className="border-t border-kumo-line px-5 py-4">
                <SectionLabel>
                  Console ({result.logs.length} entr
                  {result.logs.length === 1 ? "y" : "ies"})
                </SectionLabel>
                <div className="max-h-64 overflow-y-auto rounded-md bg-kumo-elevated p-2.5">
                  {result.logs.map((log, index) => (
                    <pre
                      // biome-ignore lint: log order is the identity
                      key={index}
                      className={`font-mono text-xs whitespace-pre-wrap break-words ${LOG_LEVEL_CLASSES[log.level] ?? "text-kumo-default"}`}
                    >
                      <span className="text-kumo-subtle">[{log.level}] </span>
                      {log.message}
                    </pre>
                  ))}
                </div>
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === "metrics" && <MetricsTab history={history} />}

      {tab === "about" && <AboutTab />}

      <footer className="flex justify-center pb-2">
        <PoweredByCloudflare />
      </footer>
    </div>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root element");
createRoot(root).render(<App />);
