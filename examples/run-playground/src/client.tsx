import "./styles.css";
import {
  Badge,
  Button,
  PoweredByCloudflare,
  Surface,
  Switch,
  Text,
  Textarea
} from "@cloudflare/kumo";
import {
  ArrowElbowDownRightIcon,
  InfoIcon,
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
    note: "Deployed, the platform meters real CPU and kills this with RUN_RESOURCE_LIMIT once cpuMs is spent — but enforcement lags a second or two, and the spinning child freezes the parent's clock, so the server-measured time underreports while the wall clock does not. Local dev does not enforce CPU budgets at all.",
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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-1.5 text-xs font-semibold text-kumo-default">{children}</p>
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

function LatencyCard({ history }: { history: RunHistoryEntry[] }) {
  if (history.length === 0) return null;
  const durations = history.map((entry) => entry.durationMs);
  const median = percentile(durations, 0.5);
  const p95 = percentile(durations, 0.95);
  const max = Math.max(...durations, 1);
  const barWidth = 8;
  const gap = 3;
  const height = 44;

  return (
    <Surface className="rounded-xl px-4 py-3 ring ring-kumo-line">
      <SectionLabel>
        Fresh isolate per run — server-side latency, last {history.length} run
        {history.length === 1 ? "" : "s"}
      </SectionLabel>
      <div className="flex items-end gap-4">
        <svg
          aria-label="Run duration history"
          width={history.length * (barWidth + gap)}
          height={height}
          className="shrink-0"
        >
          {history.map((entry, index) => {
            const barHeight = Math.max(
              3,
              Math.round((entry.durationMs / max) * (height - 4))
            );
            return (
              <rect
                // biome-ignore lint: order is the identity of a history bar
                key={index}
                x={index * (barWidth + gap)}
                y={height - barHeight}
                width={barWidth}
                height={barHeight}
                rx={1.5}
                className={entry.ok ? "fill-kumo-brand" : "fill-status-error"}
              >
                <title>{`${entry.durationMs}ms${entry.ok ? "" : " (failed)"}`}</title>
              </rect>
            );
          })}
        </svg>
        <div className="flex gap-6">
          <div>
            <p className="font-mono text-sm font-semibold text-kumo-default">
              {median}ms
            </p>
            <Text size="xs" variant="secondary">
              median
            </Text>
          </div>
          <div>
            <p className="font-mono text-sm font-semibold text-kumo-default">
              {p95}ms
            </p>
            <Text size="xs" variant="secondary">
              p95
            </Text>
          </div>
        </div>
      </div>
    </Surface>
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
  const [source, setSource] = useState(initialPreset?.source ?? "");
  const [presetId, setPresetId] = useState(initialPreset?.id);
  const [limits, setLimits] = useState<Limits>(DEFAULT_LIMITS);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunApiResponse & { wallMs: number }>();
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
    const startedAt = performance.now();
    try {
      const response = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, limits })
      });
      const body = (await response.json()) as RunApiResponse;
      setResult({
        ...body,
        wallMs: Math.round(performance.now() - startedAt)
      });
      setHistory((previous) =>
        [...previous, { durationMs: body.durationMs, ok: body.ok }].slice(-30)
      );
    } catch (error: unknown) {
      setResult({
        ok: false,
        code: "NETWORK",
        message: error instanceof Error ? error.message : String(error),
        logs: [],
        durationMs: 0,
        wallMs: Math.round(performance.now() - startedAt)
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

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <PlayIcon size={20} weight="fill" className="text-kumo-brand" />
          <h1 className="text-base font-semibold text-kumo-default">
            Run Playground
          </h1>
          <Badge variant="secondary">
            <span className="font-mono text-[0.9em]">@cloudflare/run</span>
          </Badge>
        </div>
        <ModeToggle />
      </header>

      <Surface className="rounded-xl px-4 py-3 ring ring-kumo-line">
        <div className="flex items-start gap-3">
          <span className="h-lh flex items-center">
            <InfoIcon size={20} weight="bold" className="text-kumo-brand" />
          </span>
          <div className="grid gap-1">
            <Text size="sm" bold>
              Untrusted code, fresh isolate, explicit authority
            </Text>
            <Text size="xs" variant="secondary">
              Everything you type here executes in a brand-new Dynamic Worker
              with no bindings, no imports, and no network. Its only authority
              is the demo.* host functions the server passes in. Pick a preset —
              especially the hostile ones — and watch each escape attempt come
              back as a clean, typed RunError.
            </Text>
          </div>
        </div>
      </Surface>

      <div className="grid flex-1 gap-4 lg:grid-cols-2">
        <Surface className="flex flex-col gap-3 rounded-xl px-4 py-3 ring ring-kumo-line">
          <div>
            <SectionLabel>Examples</SectionLabel>
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLE_PRESETS.map((preset) => (
                <Button
                  key={preset.id}
                  size="sm"
                  variant={preset.id === presetId ? "primary" : "secondary"}
                  onClick={() => applyPreset(preset)}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
          </div>
          <div>
            <SectionLabel>Try to break it</SectionLabel>
            <div className="flex flex-wrap gap-1.5">
              {BREAK_PRESETS.map((preset) => (
                <Button
                  key={preset.id}
                  size="sm"
                  variant={preset.id === presetId ? "primary" : "secondary"}
                  onClick={() => applyPreset(preset)}
                >
                  {preset.label}
                </Button>
              ))}
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
            className="min-h-[260px] flex-1 resize-none font-mono text-[13px]"
          />

          <div>
            <SectionLabel>Host functions available to this code</SectionLabel>
            <div className="grid gap-1">
              {HOST_FUNCTIONS.map((hostFunction) => (
                <div
                  key={hostFunction.signature}
                  className="flex flex-wrap items-baseline gap-x-2"
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

          <div>
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

          <Button
            variant="primary"
            loading={running}
            onClick={handleRun}
            icon={<PlayIcon size={14} weight="fill" />}
          >
            Run
          </Button>
        </Surface>

        <div className="flex flex-col gap-4">
          <Surface className="flex-1 rounded-xl px-4 py-3 ring ring-kumo-line">
            <div className="mb-2 flex items-center justify-between">
              <SectionLabel>Result</SectionLabel>
              <div className="flex items-center gap-3">
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
                    title="time inside run() on the server · total round trip from this browser"
                  >
                    {result.durationMs}ms server · {result.wallMs}ms total
                  </span>
                )}
              </div>
            </div>

            {result === undefined && !running && (
              <Text size="xs" variant="secondary">
                Run some code to see its result, logs, and errors here.
              </Text>
            )}
            {running && (
              <Text size="xs" variant="secondary">
                Loading a fresh isolate…
              </Text>
            )}

            {result?.ok === true && (
              <div>
                <Badge variant="success">completed</Badge>
                <pre className="mt-2 rounded-md bg-kumo-elevated p-2.5 font-mono text-xs text-status-success whitespace-pre-wrap break-words">
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
                <Badge variant="destructive">{result.code}</Badge>
                <pre className="mt-2 font-mono text-xs text-status-error whitespace-pre-wrap break-words">
                  {result.message}
                </pre>
                {result.stack !== undefined && (
                  <StackTrace stack={result.stack} onJumpToLine={jumpToLine} />
                )}
              </div>
            )}

            {result !== undefined && result.logs.length > 0 && !showRaw && (
              <div className="mt-3">
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
          </Surface>

          <LatencyCard history={history} />
        </div>
      </div>

      <footer className="flex justify-center pb-2">
        <PoweredByCloudflare />
      </footer>
    </div>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root element");
createRoot(root).render(<App />);
