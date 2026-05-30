/**
 * Deploy-rollback orchestrator (tool-result durability under REAL deploys).
 *
 * The customer reports "large rollbacks" on deploys: a whole message's worth of
 * already-completed (non-idempotent) tool calls re-running after a deploy lands
 * mid-turn. The kill/restart e2e tests can't reproduce this — only a real
 * `wrangler deploy`, which ships a new script version and resets the in-flight
 * Durable Object, exposes it.
 *
 * This driver, over plain HTTP (no browser, no WebSocket):
 *   1. starts a durable tool-using turn via the agent's `submitMessages`
 *      (`POST /drive/start`) against a REAL model (Workers AI or Anthropic),
 *      asking it to call a non-idempotent `recordStep` tool once per index;
 *   2. fires repeated real `wrangler deploy`s while that turn is in flight;
 *   3. polls `GET /drive/status` until the durable submission is terminal;
 *   4. reads the tool ledger — one row per tool EXECUTION — and reports any
 *      DUPLICATE index (a completed step that re-ran = a rollback).
 *
 * Expected with the #1621 fix: settled tool results are flushed immediately, so
 * recovery reconstructs every completed step and re-runs at most the single
 * in-flight step. A "large rollback" (duplicates >> deploys) means the fix is
 * not covering the customer's path.
 *
 * Usage (from examples/deploy-churn):
 *   npm run rollback -- --provider workers-ai --steps 24 --deploys 3
 *   npm run rollback -- --provider anthropic  --steps 24 --deploys 3
 *
 * Config (CLI flags or env):
 *   --provider                 workers-ai | anthropic   (default workers-ai)
 *   --model                    override the model id
 *   --steps N                  recordStep calls the model must make (default 24)
 *   --deploys N                mid-turn deploys (default 3)
 *   --mid-turn-delay S         wait before the first deploy (default 6)
 *   --between S                gap between deploys (default 4)
 *   --settle S                 max wait for the turn to finish after churn (default 240)
 *   --base-url / BASE_URL      full https origin of the deployed worker
 *   --worker / WORKER_NAME     worker name      (default agents-deploy-churn)
 *   --subdomain / SUBDOMAIN    workers.dev sub  (default threepointone)
 *   --session                  DO instance name (default <provider>-<runId>)
 *   --no-initial-deploy        skip the pre-run deploy (worker must already exist)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_DIR = path.resolve(__dirname, "..");
const RUNS_DIR = path.join(__dirname, "runs");

type Json = Record<string, unknown>;
type Provider = "workers-ai" | "anthropic";

type Submission = {
  submissionId: string;
  status: "pending" | "running" | "completed" | "aborted" | "skipped" | "error";
  error?: string;
};

type ToolStatus = {
  mode: string;
  provider: string;
  steps: number;
  ledger: {
    totalExecutions: number;
    uniqueIndices: number;
    duplicateIndices: Array<{ index: number; executions: number }>;
    maxIndex: number;
  };
  transcriptToolCalls: number;
  submissions: Submission[];
  turns: Array<{ status: string; continuation: boolean; error?: string }>;
  chatErrors: Array<{ stage: string; name: string; message: string }>;
  agentErrors: Array<{ name: string; message: string }>;
  incidents: Array<{
    status: string;
    attempt: number;
    maxAttempts: number;
    recoveryKind: string;
    reason?: string;
  }>;
  exhausted: unknown;
  hasFiberRows: boolean;
  assistantMessages: number;
};

// ── config ──────────────────────────────────────────────────────────────────

function argMap(argv: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (key.includes("=")) {
      const [k, v] = key.split(/=(.*)/s);
      map.set(k, v);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      map.set(key, argv[++i]);
    } else {
      map.set(key, "true");
    }
  }
  return map;
}

const args = argMap(process.argv.slice(2));
function opt(name: string, env: string, fallback: string): string {
  return args.get(name) ?? process.env[env] ?? fallback;
}
function num(name: string, env: string, fallback: number): number {
  const raw = args.get(name) ?? process.env[env];
  const v = raw == null ? fallback : Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

const PROVIDER = (
  opt("provider", "PROVIDER", "workers-ai") === "anthropic"
    ? "anthropic"
    : "workers-ai"
) as Provider;
const MODEL = args.get("model") ?? "";
const STEPS = num("steps", "STEPS", 24);
// Per-tool in-flight window. Set large (e.g. 12000) so a real ~33s deploy lands
// DURING a tool execution, exercising the code-update reset mid-tool.
const STEP_DELAY_MS = num("delay-ms", "STEP_DELAY_MS", 0);
const DEPLOYS = num("deploys", "DEPLOYS", 3);
const MID_TURN_DELAY = num("mid-turn-delay", "MID_TURN_DELAY", 6);
const BETWEEN = num("between", "BETWEEN", 4);
const SETTLE = num("settle", "SETTLE", 240);
const WORKER_NAME = opt("worker", "WORKER_NAME", "agents-deploy-churn");
const SUBDOMAIN = opt("subdomain", "SUBDOMAIN", "threepointone");
const BASE_URL = opt(
  "base-url",
  "BASE_URL",
  `https://${WORKER_NAME}.${SUBDOMAIN}.workers.dev`
).replace(/\/$/, "");
const INITIAL_DEPLOY = !args.has("no-initial-deploy");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const SESSION = opt("session", "SESSION", `${PROVIDER}-${runId}`);

// ── timeline recorder ─────────────────────────────────────────────────────────

fs.mkdirSync(RUNS_DIR, { recursive: true });
const timelinePath = path.join(RUNS_DIR, `rollback-${runId}.jsonl`);
const summaryPath = path.join(RUNS_DIR, `rollback-${runId}.summary.json`);
const timelineStream = fs.createWriteStream(timelinePath, { flags: "a" });

function record(event: string, data: Json = {}): void {
  const entry = {
    ts: Date.now(),
    iso: new Date().toISOString(),
    event,
    ...data
  };
  timelineStream.write(`${JSON.stringify(entry)}\n`);
  const detail = Object.keys(data).length ? ` ${JSON.stringify(data)}` : "";
  console.log(`[${new Date(entry.ts).toISOString()}] ${event}${detail}`);
}

// ── HTTP helpers (resilient to mid-deploy bounces) ────────────────────────────

async function http(
  method: "GET" | "POST",
  pathname: string,
  query: Record<string, string> = {}
): Promise<unknown> {
  const url = new URL(`${BASE_URL}${pathname}`);
  url.searchParams.set("session", SESSION);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const res = await fetch(url, { method });
      if (!res.ok) throw new Error(`${method} ${pathname} -> ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(1500);
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`${method} ${pathname} failed`);
}

async function status(tag: string): Promise<ToolStatus | null> {
  try {
    const s = (await http("GET", "/drive/status")) as ToolStatus;
    const submission = s.submissions[0];
    record("status", {
      tag,
      submission: submission
        ? { status: submission.status, error: submission.error }
        : null,
      ledger: s.ledger,
      transcriptToolCalls: s.transcriptToolCalls,
      assistantMessages: s.assistantMessages,
      hasFiberRows: s.hasFiberRows,
      incidents: s.incidents.length,
      chatErrors: s.chatErrors.map((e) => ({
        stage: e.stage,
        message: e.message
      })),
      exhausted: s.exhausted
    });
    return s;
  } catch (e) {
    record("status:error", {
      tag,
      error: e instanceof Error ? e.message : String(e)
    });
    return null;
  }
}

// ── deploy ────────────────────────────────────────────────────────────────────

function runDeploy(label: string): Promise<{ versionId: string | null }> {
  return new Promise((resolve, reject) => {
    record("deploy:start", { label });
    const startedAt = Date.now();
    const child = spawn("npm", ["run", "deploy"], {
      cwd: EXAMPLE_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });
    let out = "";
    const onData = (b: Buffer) => {
      out += b.toString();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", reject);
    child.on("close", (code) => {
      const versionId =
        out.match(/Current Version ID:\s*([0-9a-fA-F-]+)/)?.[1] ??
        out.match(/Version(?:\s*ID)?:\s*([0-9a-fA-F-]+)/)?.[1] ??
        null;
      record("deploy:end", {
        label,
        code,
        versionId,
        durationMs: Date.now() - startedAt
      });
      if (code !== 0) {
        reject(
          new Error(`deploy "${label}" exited ${code}\n${out.slice(-2000)}`)
        );
        return;
      }
      resolve({ versionId });
    });
  });
}

function isTerminal(s: Submission | undefined): boolean {
  return (
    !!s &&
    (s.status === "completed" || s.status === "error" || s.status === "aborted")
  );
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  record("run:start", {
    baseUrl: BASE_URL,
    session: SESSION,
    provider: PROVIDER,
    model: MODEL || "(default)",
    steps: STEPS,
    deploys: DEPLOYS,
    midTurnDelaySeconds: MID_TURN_DELAY,
    betweenSeconds: BETWEEN,
    settleSeconds: SETTLE,
    timeline: timelinePath
  });

  if (INITIAL_DEPLOY) {
    await runDeploy("initial");
    await sleep(5000);
  }

  await http("POST", "/drive/reset");
  record("reset:ok");

  const start = (await http("POST", "/drive/start", {
    provider: PROVIDER,
    steps: String(STEPS),
    ...(MODEL ? { model: MODEL } : {}),
    ...(STEP_DELAY_MS ? { delayMs: String(STEP_DELAY_MS) } : {})
  })) as { submissionId: string };
  record("turn:started", { submissionId: start.submissionId });

  record("mid-turn:wait", { seconds: MID_TURN_DELAY });
  await sleep(MID_TURN_DELAY * 1000);
  await status("before-deploys");

  const versions: Array<string | null> = [];
  for (let i = 1; i <= DEPLOYS; i++) {
    const { versionId } = await runDeploy(`churn-${i}/${DEPLOYS}`);
    versions.push(versionId);
    await status(`after-deploy-${i}`);
    if (BETWEEN > 0 && i < DEPLOYS) await sleep(BETWEEN * 1000);
  }

  record("settle:wait", { seconds: SETTLE });
  const deadline = Date.now() + SETTLE * 1000;
  let last: ToolStatus | null = null;
  while (Date.now() < deadline) {
    await sleep(4000);
    last = await status("settling");
    if (!last) continue;
    if (last.exhausted) break;
    if (isTerminal(last.submissions[0])) break;
  }

  const submission = last?.submissions[0];
  const ledger = last?.ledger ?? {
    totalExecutions: 0,
    uniqueIndices: 0,
    duplicateIndices: [],
    maxIndex: 0
  };
  const duplicates = ledger.duplicateIndices;
  const extraExecutions = ledger.totalExecutions - ledger.uniqueIndices;

  // CLEAN: no completed step re-ran. MINIMAL: re-runs <= deploys (the bounded
  // "single in-flight step" #1621 allows per interruption). ROLLBACK: more
  // completed steps re-ran than deploys happened — the customer's failure mode.
  let classification: "CLEAN" | "MINIMAL" | "ROLLBACK";
  if (extraExecutions === 0) classification = "CLEAN";
  else if (extraExecutions <= DEPLOYS) classification = "MINIMAL";
  else classification = "ROLLBACK";

  const verdict = {
    provider: PROVIDER,
    model: MODEL || "(default)",
    classification,
    submissionStatus: submission?.status ?? "unknown",
    submissionError: submission?.error,
    requestedSteps: STEPS,
    uniqueIndices: ledger.uniqueIndices,
    maxIndex: ledger.maxIndex,
    totalExecutions: ledger.totalExecutions,
    extraExecutions,
    duplicateIndices: duplicates,
    transcriptToolCalls: last?.transcriptToolCalls ?? 0,
    recoveryIncidents: last?.incidents ?? [],
    chatErrors: last?.chatErrors ?? [],
    agentErrors: last?.agentErrors ?? [],
    exhausted: last?.exhausted ?? null,
    orphanedFiberRows: last?.hasFiberRows ?? null,
    deployVersions: versions
  };
  record("verdict", verdict);

  fs.writeFileSync(
    summaryPath,
    `${JSON.stringify({ runId, verdict, finalStatus: last, timeline: timelinePath }, null, 2)}\n`
  );

  console.log("\n──────────── ROLLBACK VERDICT ────────────");
  console.log(`Provider:           ${PROVIDER} ${MODEL ? `(${MODEL})` : ""}`);
  console.log(
    `Submission:         ${verdict.submissionStatus}${verdict.submissionError ? ` (${verdict.submissionError})` : ""}`
  );
  console.log(`Requested steps:    ${STEPS}`);
  console.log(
    `Unique steps run:   ${ledger.uniqueIndices} (max index ${ledger.maxIndex})`
  );
  console.log(`Total executions:   ${ledger.totalExecutions}`);
  console.log(
    `Re-run executions:  ${extraExecutions}  (deploys this run: ${DEPLOYS})`
  );
  if (duplicates.length) {
    console.log(
      `Duplicated indices: ${duplicates.map((d) => `${d.index}×${d.executions}`).join(", ")}`
    );
  }
  console.log(`Recovery incidents: ${verdict.recoveryIncidents.length}`);
  if (verdict.chatErrors.length) {
    const byStage = verdict.chatErrors.reduce<Record<string, number>>(
      (acc, e) => {
        acc[e.stage] = (acc[e.stage] ?? 0) + 1;
        return acc;
      },
      {}
    );
    console.log(`Chat errors:        ${JSON.stringify(byStage)}`);
  }
  console.log(`\nCLASSIFICATION:     ${classification}`);
  if (classification === "ROLLBACK") {
    console.log(
      "  → LARGE ROLLBACK: completed tool calls re-ran after a deploy."
    );
  } else if (classification === "MINIMAL") {
    console.log(
      "  → Bounded re-run of in-flight steps only (expected under churn)."
    );
  } else {
    console.log(
      "  → No completed tool call re-ran. Tool results survived the deploys."
    );
  }
  console.log(`\nTimeline:  ${timelinePath}`);
  console.log(`Summary:   ${summaryPath}`);
  timelineStream.end();
}

main()
  .then(() => setTimeout(() => process.exit(0), 250))
  .catch((e) => {
    record("run:error", { error: e instanceof Error ? e.message : String(e) });
    console.error(e);
    timelineStream.end();
    setTimeout(() => process.exit(1), 250);
  });
