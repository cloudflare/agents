import "./styles.css";
import {
  Badge,
  Breadcrumbs,
  Button,
  LayerCard,
  CloudflareLogo,
  Sidebar,
  Switch,
  Text,
  Textarea
} from "@cloudflare/kumo";
import {
  ArrowElbowDownRightIcon,
  CheckCircleIcon,
  DoorOpenIcon,
  GithubLogoIcon,
  MoonIcon,
  PlayIcon,
  SunIcon,
  TerminalWindowIcon
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { RunApiResponse, RunRequestBody } from "./server";

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
  },
  {
    signature: "demo.vault()",
    description: "Always throws on the host — one of the escape room's doors."
  }
];

/**
 * Left-hand navigation entries. Each demo gets a row here; adding a second
 * demo means adding an entry and rendering its main content when selected.
 */
const DEMOS = [
  {
    id: "playground",
    label: "Run playground",
    icon: TerminalWindowIcon
  },
  {
    id: "escape",
    label: "Escape room",
    icon: DoorOpenIcon
  }
] as const;

type DemoId = (typeof DEMOS)[number]["id"];

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

/**
 * Left navigation sidebar, matching the Cloudflare dashboard's SidebarNav:
 * the same Kumo Sidebar component with the dash's background and active-item
 * CSS variable overrides, grouped sections with uppercase labels, and
 * icon-led menu buttons.
 */
function DemoSidebar({
  demo,
  onSelect
}: {
  demo: DemoId;
  onSelect: (demo: DemoId) => void;
}) {
  return (
    <Sidebar className="sticky top-0 h-svh [--sidebar-active-bg:var(--color-kumo-recessed)] [--sidebar-bg:var(--color-kumo-base)] dark:[--sidebar-active-bg:var(--color-kumo-control)]">
      <Sidebar.Header>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <CloudflareLogo
            variant="glyph"
            className="h-5 w-auto shrink-0"
            aria-hidden
          />
          <span className="truncate font-mono text-sm font-medium text-kumo-default">
            @cloudflare/run
          </span>
        </div>
      </Sidebar.Header>
      <Sidebar.Content>
        <Sidebar.Group>
          <Sidebar.GroupLabel>Demos</Sidebar.GroupLabel>
          <Sidebar.Menu>
            {DEMOS.map((entry) => (
              <Sidebar.MenuItem key={entry.id}>
                <Sidebar.MenuButton
                  icon={entry.icon}
                  active={demo === entry.id}
                  onClick={() => onSelect(entry.id)}
                >
                  {entry.label}
                </Sidebar.MenuButton>
              </Sidebar.MenuItem>
            ))}
          </Sidebar.Menu>
        </Sidebar.Group>
        <Sidebar.Group>
          <Sidebar.GroupLabel>Resources</Sidebar.GroupLabel>
          <Sidebar.Menu>
            <Sidebar.MenuItem>
              <Sidebar.MenuButton
                icon={GithubLogoIcon}
                href="https://github.com/cloudflare/agents"
                target="_blank"
              >
                cloudflare/agents
              </Sidebar.MenuButton>
            </Sidebar.MenuItem>
          </Sidebar.Menu>
        </Sidebar.Group>
      </Sidebar.Content>
    </Sidebar>
  );
}

/**
 * Layered dashboard card, matching the Workers service-overview cards in the
 * Cloudflare dashboard: a muted header strip (`LayerCard.Secondary`) above a
 * white inner panel (`LayerCard.Primary`).
 */
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
    <LayerCard className={className}>
      <LayerCard.Secondary className="justify-between">
        <div className="flex min-w-0 items-center gap-2">{title}</div>
        {meta !== undefined && (
          <div className="flex shrink-0 items-center gap-2">{meta}</div>
        )}
      </LayerCard.Secondary>
      <LayerCard.Primary className="gap-0 p-0 pr-0">
        {children}
      </LayerCard.Primary>
    </LayerCard>
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
        className="w-full accent-neutral-400 dark:accent-neutral-600"
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
    <div className="p-4">
      <Text size="sm" variant="secondary">
        {label}
      </Text>
      <p className="mt-1 text-2xl font-semibold text-kumo-default">{value}</p>
    </div>
  );
}

function MetricsCard({ history }: { history: RunHistoryEntry[] }) {
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
        <div className="px-4 py-8">
          <Text size="sm" variant="secondary">
            No runs yet. Run some code above and the server-side duration of
            each fresh isolate shows up here.
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
          <div className="border-t border-kumo-line p-4">
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

/**
 * Right-hand info column, matching the dashboard's service-overview aside
 * ("Domains and routes" / "Next steps"): a narrow sticky stack of compact
 * layered cards.
 */
function AboutAside() {
  return (
    <>
      <Card title="How it works">
        <div className="grid gap-3 p-4">
          <Text size="sm">
            Everything you run here executes in a brand-new{" "}
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
              className="grid gap-1 border-b border-kumo-line px-4 py-3 last:border-b-0"
            >
              <code className="w-fit rounded bg-kumo-elevated px-1.5 py-0.5 font-mono text-xs text-kumo-default">
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
              className="grid gap-1 border-b border-kumo-line px-4 py-3 last:border-b-0"
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
    </>
  );
}

/** Insert two spaces at the cursor when Tab is pressed inside an editor. */
function insertEditorTab(
  event: React.KeyboardEvent<HTMLTextAreaElement>,
  source: string,
  setSource: (value: string) => void
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

type EscapeLimits = NonNullable<RunRequestBody["limits"]>;

interface EscapeLevel {
  /** The RunError code this door collects. */
  code: string;
  title: string;
  goal: string;
  source: string;
  limits?: EscapeLimits;
  abortAfterMs?: number;
  /** Shown when the level only behaves this way deployed, not in local dev. */
  warning?: string;
}

/**
 * One level per RunError code, easiest doors first. Winning a level means
 * making run() reject with exactly that code.
 */
const ESCAPE_LEVELS: EscapeLevel[] = [
  {
    code: "RUN_COMPILE_ERROR",
    title: "Smuggle in an import",
    goal: "Pull in a module. Imports — static or dynamic — are rejected before any Worker is even loaded.",
    source: `import { readFileSync } from "node:fs";
return readFileSync("/etc/passwd", "utf8");
`
  },
  {
    code: "RUN_EXECUTION_ERROR",
    title: "Reach the network",
    goal: "Make an outbound request. The sandbox has no network at the platform level — there is no fetch to monkey-patch back.",
    source: `return await fetch("https://example.com");
`
  },
  {
    code: "RUN_SERIALIZATION_ERROR",
    title: "Sneak a function out",
    goal: "Return something the RPC boundary refuses to carry — like live code.",
    source: `return () => "backdoor";
`
  },
  {
    code: "RUN_TIMEOUT",
    title: "Outlive the wall clock",
    goal: "This level's wall-clock budget is 1.5 seconds. Wait longer than the parent allows.",
    limits: { timeoutMs: 1_500 },
    source: `await new Promise((resolve) => setTimeout(resolve, 60_000));
return "still here";
`
  },
  {
    code: "RUN_HOST_FUNCTION_ERROR",
    title: "Open the vault",
    goal: "demo.vault() throws on the host. The failure crosses back as one sanitized error — host internals never leak into the sandbox.",
    source: `return await demo.vault();
`
  },
  {
    code: "RUN_HOST_FUNCTION_LIMIT",
    title: "Hammer the host",
    goal: "This level allows 3 host calls per run. Make more.",
    limits: { maxHostFunctionCalls: 3 },
    source: `for (let i = 0; i < 10; i++) {
  await demo.wait(1);
}
return "done hammering";
`
  },
  {
    code: "RUN_DETACHED_HOST_FUNCTION",
    title: "Leave a call dangling",
    goal: "Start a host call, then return without it. The run refuses to settle cleanly around a dangling host call.",
    source: `demo.wait(60_000).catch(() => {});
return "gone before it settles";
`
  },
  {
    code: "RUN_ABORTED",
    title: "Get unplugged",
    goal: "For this level the server pulls the plug 750 ms in — cancellation reaches the in-flight host call, and the child is disposed.",
    abortAfterMs: 750,
    source: `await demo.wait(30_000);
return "unreachable";
`
  },
  {
    code: "RUN_SOURCE_TOO_LARGE",
    title: "Write a novel",
    goal: "This level's source budget is 256 bytes — and this program is under it. Pad it past the line, then run.",
    limits: { maxSourceBytes: 256 },
    source: `// Budget: 256 bytes of source. This program is under it.
// Add code or comments until you blow the budget.
return "tiny";
`
  },
  {
    code: "RUN_INVALID_INPUT",
    title: "Break the contract",
    goal: "This level ships an illegal limits object (timeoutMs: 0 — the minimum is 1). run() rejects before anything loads; your code is never even compiled.",
    limits: { timeoutMs: 0 },
    source: `return "this never runs";
`
  },
  {
    code: "RUN_RESOURCE_LIMIT",
    title: "Burn the CPU",
    goal: "Spin synchronously against a 500 ms CPU budget until the platform kills the isolate.",
    limits: { cpuMs: 500, timeoutMs: 120_000 },
    warning:
      "Deployed only — local dev doesn't meter CPU, so this loop just runs to completion (slowly).",
    source: `let x = 0;
for (let i = 0; i < 3_000_000_000; i++) {
  x += Math.sqrt(i);
}
return x;
`
  },
  {
    code: "RUN_WORKER_ERROR",
    title: "Hang the runtime",
    goal: "Await a promise nothing will ever settle. workerd's hang detector notices code that can never produce a response and kills the request.",
    limits: { timeoutMs: 5_000 },
    warning:
      "Deployed only — in local dev the wall clock wins instead and you get RUN_TIMEOUT.",
    source: `await new Promise(() => {});
return "unreachable";
`
  }
];

const ESCAPE_STORAGE_KEY = "run-escape-collected";

function loadCollectedCodes(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(ESCAPE_STORAGE_KEY) ?? "[]"
    );
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((code): code is string => typeof code === "string")
    );
  } catch {
    return new Set();
  }
}

/** ESCAPE_LEVELS is a nonempty literal; indexing still types as undefined. */
function getEscapeLevel(index: number): EscapeLevel {
  const level = ESCAPE_LEVELS[index];
  if (level === undefined) throw new Error(`No escape level ${index}`);
  return level;
}

/** The bingo board: one row per RunError code, lit once collected. */
function EscapeBoard({
  collected,
  activeIndex,
  onSelect
}: {
  collected: Set<string>;
  activeIndex: number;
  onSelect: (index: number) => void;
}) {
  return (
    <Card
      title="The board"
      meta={
        <span className="font-mono text-xs text-kumo-subtle">
          {collected.size} / {ESCAPE_LEVELS.length}
        </span>
      }
    >
      <div>
        {ESCAPE_LEVELS.map((level, index) => {
          const done = collected.has(level.code);
          return (
            <button
              key={level.code}
              type="button"
              onClick={() => onSelect(index)}
              aria-pressed={index === activeIndex}
              className={`flex w-full cursor-pointer items-center gap-2 border-b border-kumo-line px-4 py-2 text-left last:border-b-0 hover:bg-kumo-elevated ${
                index === activeIndex ? "bg-kumo-elevated" : ""
              }`}
            >
              <CheckCircleIcon
                size={14}
                weight={done ? "fill" : "regular"}
                className={
                  done
                    ? "shrink-0 text-status-success"
                    : "shrink-0 text-kumo-subtle"
                }
              />
              <span
                className={`truncate font-mono text-xs ${
                  done ? "text-kumo-default" : "text-kumo-subtle"
                }`}
              >
                {level.code}
              </span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

/**
 * Idea #2 from the demo list: the error-code escape room. Each level dares
 * you to reach something you shouldn't; "winning" a level means collecting
 * its RunError code. All twelve codes fill the board.
 */
function EscapeRoom() {
  const [levelIndex, setLevelIndex] = useState(0);
  const [collected, setCollected] = useState<Set<string>>(loadCollectedCodes);
  const [source, setSource] = useState(() => getEscapeLevel(0).source);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunApiResponse>();
  const level = getEscapeLevel(levelIndex);

  function selectLevel(index: number) {
    setLevelIndex(index);
    setSource(getEscapeLevel(index).source);
    setResult(undefined);
  }

  function resetBoard() {
    localStorage.removeItem(ESCAPE_STORAGE_KEY);
    setCollected(new Set());
  }

  async function handleRun() {
    setRunning(true);
    setResult(undefined);
    try {
      const body: RunRequestBody = {
        source,
        ...(level.limits === undefined ? {} : { limits: level.limits }),
        ...(level.abortAfterMs === undefined
          ? {}
          : { abortAfterMs: level.abortAfterMs })
      };
      const response = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const outcome = (await response.json()) as RunApiResponse;
      setResult(outcome);
      if (!outcome.ok && outcome.code === level.code) {
        setCollected((previous) => {
          const next = new Set(previous);
          next.add(level.code);
          localStorage.setItem(ESCAPE_STORAGE_KEY, JSON.stringify([...next]));
          return next;
        });
      }
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

  const matched = result?.ok === false && result.code === level.code;

  return (
    <div className="flex flex-col gap-6 xl:flex-row">
      <div className="flex min-w-0 grow flex-col gap-5">
        <Card
          title={`Level ${levelIndex + 1}: ${level.title}`}
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
          <div className="grid gap-3 p-4">
            <div>
              <SectionLabel>Levels</SectionLabel>
              <div className="flex flex-wrap gap-1.5">
                {ESCAPE_LEVELS.map((entry, index) => (
                  <Button
                    key={entry.code}
                    size="sm"
                    variant={index === levelIndex ? "secondary" : "ghost"}
                    aria-pressed={index === levelIndex}
                    onClick={() => selectLevel(index)}
                    icon={
                      collected.has(entry.code) ? (
                        <CheckCircleIcon
                          size={12}
                          weight="fill"
                          className="text-status-success"
                        />
                      ) : undefined
                    }
                  >
                    {index + 1}
                  </Button>
                ))}
              </div>
            </div>

            <div className="grid gap-1.5">
              <Text size="sm">{level.goal}</Text>
              <div className="flex flex-wrap items-center gap-1.5">
                <Text size="xs" variant="secondary">
                  Target:
                </Text>
                <code className="rounded bg-kumo-elevated px-1.5 py-0.5 font-mono text-xs text-kumo-default">
                  {level.code}
                </code>
                {level.limits !== undefined && (
                  <code className="rounded bg-kumo-elevated px-1.5 py-0.5 font-mono text-xs text-kumo-subtle">
                    {Object.entries(level.limits)
                      .map(([key, value]) => `${key}: ${value}`)
                      .join(", ")}
                  </code>
                )}
              </div>
              {level.warning !== undefined && (
                <p className="text-xs text-status-warning">{level.warning}</p>
              )}
            </div>

            <Textarea
              value={source}
              onChange={(event) => setSource(event.currentTarget.value)}
              onKeyDown={(event) => insertEditorTab(event, source, setSource)}
              spellCheck={false}
              aria-label="Escape attempt editor"
              className="min-h-[180px] resize-y font-mono text-[13px]"
            />
          </div>
        </Card>

        <Card
          title="Attempt"
          meta={
            <>
              {result !== undefined && (
                <span
                  className="font-mono text-xs text-kumo-subtle"
                  title="time spent inside run() on the server"
                >
                  {result.durationMs}ms
                </span>
              )}
              {result?.ok === true && <Badge variant="warning">escaped?</Badge>}
              {result?.ok === false && (
                <Badge variant={matched ? "success" : "destructive"}>
                  {result.code}
                </Badge>
              )}
            </>
          }
        >
          <div className="p-4">
            {result === undefined && !running && (
              <Text size="sm" variant="secondary">
                Run your escape attempt to see what comes back.
              </Text>
            )}
            {running && (
              <Text size="sm" variant="secondary">
                Loading a fresh isolate…
              </Text>
            )}

            {result?.ok === true && (
              <div className="grid gap-2">
                <Text size="sm">
                  The run completed normally — no escape here. Value:
                </Text>
                <pre className="rounded-md bg-kumo-elevated p-2.5 font-mono text-xs text-kumo-default whitespace-pre-wrap break-words">
                  {result.value}
                </pre>
              </div>
            )}

            {result?.ok === false && (
              <div className="grid gap-2">
                <Text size="sm">
                  {matched
                    ? `Collected ${level.code} — the escape came back as one typed error.`
                    : `That raised ${result.code}, but this door wants ${level.code}.`}
                </Text>
                <pre className="font-mono text-xs text-status-error whitespace-pre-wrap break-words">
                  {result.message}
                </pre>
              </div>
            )}
          </div>

          {result !== undefined && result.logs.length > 0 && (
            <div className="border-t border-kumo-line p-4">
              <SectionLabel>Console</SectionLabel>
              <div className="max-h-48 overflow-y-auto rounded-md bg-kumo-elevated p-2.5">
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

      <aside className="flex w-full flex-col gap-5 xl:sticky xl:top-[4.25rem] xl:h-fit xl:w-[300px] xl:shrink-0">
        <EscapeBoard
          collected={collected}
          activeIndex={levelIndex}
          onSelect={selectLevel}
        />
        <Card
          title="House rules"
          meta={
            collected.size > 0 && (
              <Button size="sm" variant="ghost" onClick={resetBoard}>
                Reset
              </Button>
            )
          }
        >
          <div className="grid gap-3 p-4">
            <Text size="sm">
              Twelve locked doors, one per{" "}
              <span className="font-mono text-[0.9em]">RunError</span> code.
              Each level dares you to reach something you shouldn't — the
              network, the host, the clock, the RPC boundary. Trigger exactly
              the level's code to collect it.
            </Text>
            <Text size="sm" variant="secondary">
              The code is fully editable — the prefilled attempt is just a head
              start. Every failure comes back the same way: one typed error with
              a stable code and bounded logs, never a host stack trace.
            </Text>
          </div>
        </Card>
      </aside>
    </div>
  );
}

export function App() {
  const initialPreset = EXAMPLE_PRESETS[0];
  const [demo, setDemo] = useState<DemoId>("playground");
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
    insertEditorTab(event, source, setSource);
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
    <Sidebar.Provider>
      <DemoSidebar demo={demo} onSelect={setDemo} />

      <div className="flex min-h-svh min-w-0 flex-1 flex-col bg-kumo-canvas">
        {/* Breadcrumb header row, like the dashboard's global chrome. */}
        <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center justify-between gap-3 border-b border-kumo-line bg-kumo-base px-4 md:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <Sidebar.Trigger />
            <Breadcrumbs size="sm">
              <Breadcrumbs.Link href="https://github.com/cloudflare/agents">
                <span className="font-mono">@cloudflare/run</span>
              </Breadcrumbs.Link>
              <Breadcrumbs.Separator />
              <Breadcrumbs.Current>run-playground</Breadcrumbs.Current>
            </Breadcrumbs>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <div className="hidden items-center lg:flex">
              <Text size="sm" variant="secondary">
                Untrusted code, fresh isolate per run
              </Text>
            </div>
            <ModeToggle />
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1600px] grow px-4 pt-8 pb-6 md:px-8">
          {demo === "escape" && <EscapeRoom />}
          {demo === "playground" && (
            /* Main + aside columns, like the dashboard's PageColumns. */
            <div className="flex flex-col gap-6 xl:flex-row">
              <div className="flex min-w-0 grow flex-col gap-5">
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
                  <div className="grid gap-3 p-4">
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
                          <ArrowElbowDownRightIcon
                            size={14}
                            className="shrink-0"
                          />
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
                  </div>

                  <div className="border-t border-kumo-line p-4">
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
                          setLimits((previous) => ({
                            ...previous,
                            maxLogBytes
                          }))
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
                  <div className="p-4">
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
                            The full run result object — status, value, and
                            captured logs.
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

                  {result !== undefined &&
                    result.logs.length > 0 &&
                    !showRaw && (
                      <div className="border-t border-kumo-line p-4">
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
                              <span className="text-kumo-subtle">
                                [{log.level}]{" "}
                              </span>
                              {log.message}
                            </pre>
                          ))}
                        </div>
                      </div>
                    )}
                </Card>

                <MetricsCard history={history} />
              </div>

              {/* Sticky info aside, like the dashboard's right-hand column. */}
              <aside className="flex w-full flex-col gap-5 xl:sticky xl:top-[4.25rem] xl:h-fit xl:w-[300px] xl:shrink-0">
                <AboutAside />
              </aside>
            </div>
          )}
        </main>
      </div>
    </Sidebar.Provider>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root element");
createRoot(root).render(<App />);
