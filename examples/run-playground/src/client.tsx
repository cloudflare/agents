import "./styles.css";
import {
  Badge,
  Button,
  Input,
  PoweredByCloudflare,
  Surface,
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
  limits?: { timeoutMs?: number; cpuMs?: number; maxLogBytes?: number };
}

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
    note: "Deployed, the platform meters real CPU and kills this with RUN_RESOURCE_LIMIT once cpuMs is spent. Local dev does not enforce CPU budgets, so here it just takes a few seconds.",
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
    limits: { maxLogBytes: 2048 }
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
    <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-kumo-inactive">
      {children}
    </p>
  );
}

function LimitLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-1.5 font-mono text-[11px] font-semibold text-kumo-inactive">
      {children}
    </p>
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
    <Surface className="rounded-xl p-4 ring ring-kumo-line">
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
                className={entry.ok ? "fill-kumo-accent" : "fill-status-error"}
              >
                <title>{`${entry.durationMs}ms${entry.ok ? "" : " (failed)"}`}</title>
              </rect>
            );
          })}
        </svg>
        <div className="flex gap-6">
          <div>
            <p className="font-mono text-lg font-semibold text-kumo-default">
              {median}ms
            </p>
            <Text size="xs" variant="secondary">
              median
            </Text>
          </div>
          <div>
            <p className="font-mono text-lg font-semibold text-kumo-default">
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
              className="font-mono text-[11px] text-kumo-inactive whitespace-pre-wrap break-words"
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
            className="block w-full cursor-pointer rounded px-1 text-left font-mono text-[11px] text-kumo-accent underline decoration-dotted underline-offset-2 whitespace-pre-wrap break-words hover:bg-kumo-elevated"
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
  debug: "text-kumo-inactive"
};

export function App() {
  const initialPreset = EXAMPLE_PRESETS[0];
  const [source, setSource] = useState(initialPreset?.source ?? "");
  const [presetId, setPresetId] = useState(initialPreset?.id);
  const [timeoutMs, setTimeoutMs] = useState("");
  const [cpuMs, setCpuMs] = useState("");
  const [maxLogBytes, setMaxLogBytes] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunApiResponse>();
  const [history, setHistory] = useState<RunHistoryEntry[]>([]);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  const activePreset = ALL_PRESETS.find((preset) => preset.id === presetId);

  function applyPreset(preset: Preset) {
    setPresetId(preset.id);
    setSource(preset.source);
    setTimeoutMs(preset.limits?.timeoutMs?.toString() ?? "");
    setCpuMs(preset.limits?.cpuMs?.toString() ?? "");
    setMaxLogBytes(preset.limits?.maxLogBytes?.toString() ?? "");
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
    const limits: Record<string, number> = {};
    if (timeoutMs !== "") limits.timeoutMs = Number(timeoutMs);
    if (cpuMs !== "") limits.cpuMs = Number(cpuMs);
    if (maxLogBytes !== "") limits.maxLogBytes = Number(maxLogBytes);
    try {
      const response = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source,
          ...(Object.keys(limits).length === 0 ? {} : { limits })
        })
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

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <PlayIcon size={20} weight="fill" className="text-kumo-accent" />
          <h1 className="text-lg font-semibold text-kumo-default">
            Run Playground
          </h1>
          <Badge variant="secondary">@cloudflare/run</Badge>
        </div>
        <ModeToggle />
      </header>

      <Surface className="rounded-xl p-4 ring ring-kumo-line">
        <div className="flex gap-3">
          <InfoIcon
            size={20}
            weight="bold"
            className="mt-0.5 shrink-0 text-kumo-accent"
          />
          <div>
            <Text size="sm" bold>
              Untrusted code, fresh isolate, explicit authority
            </Text>
            <span className="mt-1 block">
              <Text size="xs" variant="secondary">
                Everything you type here executes in a brand-new Dynamic Worker
                with no bindings, no imports, and no network. Its only authority
                is the demo.* host functions the server passes in. Pick a preset
                — especially the hostile ones — and watch each escape attempt
                come back as a clean, typed RunError.
              </Text>
            </span>
          </div>
        </div>
      </Surface>

      <div className="grid flex-1 gap-4 lg:grid-cols-2">
        <Surface className="flex flex-col gap-3 rounded-xl p-4 ring ring-kumo-line">
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
            <div className="flex items-start gap-1.5 text-kumo-inactive">
              <ArrowElbowDownRightIcon size={14} className="mt-0.5 shrink-0" />
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
            className="min-h-[300px] flex-1 resize-none font-mono text-[13px]"
          />

          <div className="flex flex-wrap items-end gap-2">
            <div className="w-28">
              <LimitLabel>timeoutMs</LimitLabel>
              <Input
                type="number"
                value={timeoutMs}
                placeholder="30000"
                onValueChange={setTimeoutMs}
                aria-label="Wall timeout in milliseconds"
              />
            </div>
            <div className="w-28">
              <LimitLabel>cpuMs</LimitLabel>
              <Input
                type="number"
                value={cpuMs}
                placeholder="5000"
                onValueChange={setCpuMs}
                aria-label="CPU budget in milliseconds"
              />
            </div>
            <div className="w-28">
              <LimitLabel>maxLogBytes</LimitLabel>
              <Input
                type="number"
                value={maxLogBytes}
                placeholder="262144"
                onValueChange={setMaxLogBytes}
                aria-label="Maximum retained log bytes"
              />
            </div>
            <div className="ml-auto">
              <Button
                variant="primary"
                loading={running}
                onClick={handleRun}
                icon={<PlayIcon size={14} weight="fill" />}
              >
                Run
              </Button>
            </div>
          </div>
        </Surface>

        <div className="flex flex-col gap-4">
          <Surface className="flex-1 rounded-xl p-4 ring ring-kumo-line">
            <div className="mb-2 flex items-center justify-between">
              <SectionLabel>Result</SectionLabel>
              {result !== undefined && (
                <span className="font-mono text-[11px] text-kumo-inactive">
                  {result.durationMs}ms
                </span>
              )}
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
                  {result.value}
                </pre>
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

            {result !== undefined && result.logs.length > 0 && (
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
                      className={`font-mono text-[11px] whitespace-pre-wrap break-words ${LOG_LEVEL_CLASSES[log.level] ?? "text-kumo-default"}`}
                    >
                      <span className="text-kumo-inactive">[{log.level}] </span>
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
