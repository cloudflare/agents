/**
 * Deploy-churn orchestrator.
 *
 * Reproduces the *real deploy* failure mode that wrangler-dev kill/restart
 * tests cannot: it starts a long durable chat turn against the DEPLOYED worker,
 * then fires repeated real `wrangler deploy`s while that turn is in flight. Each
 * deploy ships a new script version, so the in-flight Durable Object is reset
 * with "Durable Object reset because its code was updated".
 *
 * It records a millisecond-resolution timeline (every WebSocket bounce, deploy,
 * version id, and recovery-incident transition) to scripts/runs/<ts>.jsonl, then
 * answers the two questions from the customer report:
 *
 *   1. Did chat recovery continue the interrupted turn on fresh code, or did it
 *      burn its in-process retry budget on a stale isolate and give up?
 *   2. Is the *Durable Object* wedged, or only the one orphaned turn? (We send a
 *      fresh message afterward to prove the DO re-instantiates healthily.)
 *
 * Usage (from examples/deploy-churn):
 *   npm run churn -- --deploys 3 --duration 90 --mid-turn-delay 8
 *
 * Config (CLI flags or env):
 *   --base-url / BASE_URL            full https origin of the deployed worker
 *   --worker / WORKER_NAME           worker name      (default agents-deploy-churn)
 *   --subdomain / SUBDOMAIN          workers.dev sub  (default threepointone)
 *   --agent-path / AGENT_PATH        kebab agent path (default deploy-churn-agent)
 *   --session / SESSION              DO instance name (default default)
 *   --deploys N                      number of mid-turn deploys (default 3)
 *   --duration S                     turn length in seconds (default 90)
 *   --mid-turn-delay S               wait before first deploy (default 8)
 *   --between S                      gap between deploys (default 0 = back to back)
 *   --settle S                       recovery wait after last deploy (default 150)
 *   --no-initial-deploy              skip the pre-run deploy (worker must exist)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket as ReconnectingWebSocket } from "partysocket";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_DIR = path.resolve(__dirname, "..");
const RUNS_DIR = path.join(__dirname, "runs");

type Json = Record<string, unknown>;

type TurnRecord = {
  at: number;
  requestId: string;
  continuation: boolean;
  status: "completed" | "error" | "aborted";
  error?: string;
  textLength: number;
};

type ChatErrorRecord = {
  at: number;
  requestId?: string;
  stage: string;
  messagesPersisted?: boolean;
  name: string;
  message: string;
};

type AgentErrorRecord = { at: number; name: string; message: string };

type IncidentRecord = {
  incidentId: string;
  attempt: number;
  maxAttempts: number;
  status: string;
  recoveryKind: string;
  reason?: string;
};

type AgentStatus = {
  name: string;
  messageCount: number;
  assistantMessages: number;
  turns: TurnRecord[];
  chatErrors: ChatErrorRecord[];
  agentErrors: AgentErrorRecord[];
  recoveryContexts: unknown[];
  incidents: IncidentRecord[];
  exhausted: unknown;
  hasFiberRows: boolean;
  chunkWrites: number;
};

// ── config ────────────────────────────────────────────────────────────────

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

const WORKER_NAME = opt("worker", "WORKER_NAME", "agents-deploy-churn");
const SUBDOMAIN = opt("subdomain", "SUBDOMAIN", "threepointone");
const BASE_URL = opt(
  "base-url",
  "BASE_URL",
  `https://${WORKER_NAME}.${SUBDOMAIN}.workers.dev`
);
const AGENT_PATH = opt("agent-path", "AGENT_PATH", "deploy-churn-agent");
const SESSION = opt("session", "SESSION", "default");
const DEPLOYS = num("deploys", "DEPLOYS", 3);
const DURATION = num("duration", "DURATION", 90);
const MID_TURN_DELAY = num("mid-turn-delay", "MID_TURN_DELAY", 8);
const BETWEEN = num("between", "BETWEEN", 0);
const SETTLE = num("settle", "SETTLE", 150);
const INITIAL_DEPLOY = !args.has("no-initial-deploy");
const RESET = !args.has("no-reset");
const MONITOR = !args.has("no-monitor");
// "raw"  = fixed 500ms reconnect (aggressive baseline)
// "partysocket" = the REAL frontend client (default backoff: 3s→10s, factor 1.3,
//                 retryCount reset after 5s uptime) via `useAgent`/usePartySocket.
const CLIENT = opt("client", "CLIENT", "raw");
// "chat" (default) probes chat recovery; "subagent" probes #1630 sub-agent
// re-attach: a parent drives a child via agentTool, deploys land mid-child-loop,
// and we check whether the parent collects the recovered child vs re-runs it.
const MODE = opt("mode", "MODE", "chat");
const SUB_AGENT_CHILD_STEPS = 30;

const httpOrigin = BASE_URL.replace(/\/$/, "");
const wsOrigin = httpOrigin.replace(/^http/, "ws");
const AGENT_WS_URL = `${wsOrigin}/agents/${AGENT_PATH}/${SESSION}`;

// ── timeline recorder ───────────────────────────────────────────────────────

fs.mkdirSync(RUNS_DIR, { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const timelinePath = path.join(RUNS_DIR, `${runId}.jsonl`);
const summaryPath = path.join(RUNS_DIR, `${runId}.summary.json`);
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

// ── WebSocket helpers ───────────────────────────────────────────────────────

/** One-shot RPC over a fresh WebSocket; resilient to mid-deploy bounces. */
async function rpc(method: string, rpcArgs: unknown[] = []): Promise<unknown> {
  const attempts = 8;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await rpcOnce(method, rpcArgs);
    } catch (e) {
      lastErr = e;
      await sleep(1500);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`rpc ${method} failed`);
}

function rpcOnce(method: string, rpcArgs: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(AGENT_WS_URL);
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(new Error(`rpc ${method} timed out`));
    }, 12_000);

    ws.onopen = () =>
      ws.send(JSON.stringify({ type: "rpc", id, method, args: rpcArgs }));
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type === "rpc" && msg.id === id) {
          clearTimeout(timer);
          ws.close();
          if (msg.success) resolve(msg.result);
          else reject(new Error(msg.error || "rpc failed"));
        }
      } catch {
        // ignore non-rpc frames
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`rpc ${method} socket error`));
    };
  });
}

/** Start a durable chat turn, then drop the socket (the turn runs server-side). */
function startTurn(text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(AGENT_WS_URL);
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(new Error("startTurn timed out"));
    }, 12_000);

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "cf_agent_use_chat_request",
          id: requestId,
          init: {
            method: "POST",
            body: JSON.stringify({
              messages: [
                {
                  id: `user-${Date.now()}`,
                  role: "user",
                  parts: [{ type: "text", text }]
                }
              ]
            })
          }
        })
      );
      // Give the server a moment to spin up the fiber, then disconnect.
      setTimeout(() => {
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          // ignore
        }
        resolve(requestId);
      }, 2500);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("startTurn socket error"));
    };
  });
}

/**
 * Persistent client that reconnects whenever the socket drops — this is what
 * mirrors the browser SPA "reconnect storm" the report described, and lets us
 * timestamp every connection bounce caused by a deploy.
 */
function startConnectionMonitor(): { stop: () => void } {
  let opens = 0;

  // Real frontend client: partysocket reconnects itself with exponential
  // backoff (defaults). We just observe the bounce cadence.
  if (CLIENT === "partysocket") {
    const rws = new ReconnectingWebSocket(AGENT_WS_URL, [], { debug: false });
    rws.addEventListener("open", () => {
      opens += 1;
      record("ws:open", { opens, client: "partysocket" });
    });
    rws.addEventListener("close", () => record("ws:close", {}));
    rws.addEventListener("error", () => record("ws:error", {}));
    return {
      stop: () => {
        try {
          rws.close();
        } catch {
          // ignore
        }
      }
    };
  }

  // Raw baseline: fixed 500ms reconnect (more aggressive than partysocket).
  let stopped = false;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(AGENT_WS_URL);
    ws.onopen = () => {
      opens += 1;
      record("ws:open", { opens });
    };
    ws.onclose = () => {
      if (stopped) return;
      record("ws:close", {});
      reconnectTimer = setTimeout(connect, 500);
    };
    ws.onerror = () => {
      record("ws:error", {});
    };
  };
  connect();
  return {
    stop: () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        ws?.close();
      } catch {
        // ignore
      }
    }
  };
}

// ── deploy ──────────────────────────────────────────────────────────────────

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

// ── status snapshots ─────────────────────────────────────────────────────────

async function snapshot(tag: string): Promise<AgentStatus | null> {
  try {
    const status = (await rpc("getStatus")) as AgentStatus;
    record("status", {
      tag,
      messageCount: status.messageCount,
      assistantMessages: status.assistantMessages,
      recoveries: status.recoveryContexts.length,
      hasFiberRows: status.hasFiberRows,
      chunkWrites: status.chunkWrites,
      turns: status.turns.map((t) => ({
        origin: t.continuation ? "continuation" : "user",
        status: t.status,
        chars: t.textLength,
        error: t.error
      })),
      chatErrors: status.chatErrors.map((e) => ({
        stage: e.stage,
        name: e.name,
        message: e.message,
        requestId: e.requestId
      })),
      agentErrors: status.agentErrors,
      incidents: status.incidents.map((i) => ({
        status: i.status,
        attempt: i.attempt,
        max: i.maxAttempts,
        kind: i.recoveryKind,
        reason: i.reason
      })),
      exhausted: status.exhausted
    });
    return status;
  } catch (e) {
    record("status:error", {
      tag,
      error: e instanceof Error ? e.message : String(e)
    });
    return null;
  }
}

// ── sub-agent re-attach mode (#1630) ────────────────────────────────────────

type SubAgentStatus = {
  parentChildStatus: string | null;
  childRunRowCount: number;
  parentHasFiberRows: boolean;
  turns: TurnRecord[];
  incidents: IncidentRecord[];
  child: {
    totalExecutions: number;
    uniqueIndices: number;
    maxIndex: number;
    duplicates: Array<{ index: number; count: number }>;
    recoveryCount: number;
    assistantMessages: number;
    hasFiberRows: boolean;
  } | null;
};

async function subSnapshot(tag: string): Promise<SubAgentStatus | null> {
  try {
    const status = (await rpc("getSubAgentStatus")) as SubAgentStatus;
    record("subagent:status", {
      tag,
      parentChildStatus: status.parentChildStatus,
      childRunRowCount: status.childRunRowCount,
      parentHasFiberRows: status.parentHasFiberRows,
      child: status.child
    });
    return status;
  } catch (e) {
    record("subagent:status:error", {
      tag,
      error: e instanceof Error ? e.message : String(e)
    });
    return null;
  }
}

async function mainSubAgent(): Promise<void> {
  record("run:start", {
    mode: "subagent",
    baseUrl: httpOrigin,
    agentWsUrl: AGENT_WS_URL,
    session: SESSION,
    deploys: DEPLOYS,
    midTurnDelaySeconds: MID_TURN_DELAY,
    betweenSeconds: BETWEEN,
    settleSeconds: SETTLE,
    childSteps: SUB_AGENT_CHILD_STEPS,
    timeline: timelinePath
  });

  if (INITIAL_DEPLOY) {
    await runDeploy("initial");
    await sleep(5000);
  }

  if (RESET) {
    try {
      await rpc("reset");
      record("reset:ok");
    } catch (e) {
      record("reset:error", {
        error: e instanceof Error ? e.message : String(e)
      });
    }
  }

  // Switch the parent into sub-agent (agentTool) mode, then kick the turn.
  await rpc("configureSubAgentRun");
  record("subagent:configured");

  const monitor = MONITOR ? startConnectionMonitor() : { stop: () => {} };

  const turnRequestId = await startTurn("Run the seeding task via runTask.");
  record("turn:sent", { requestId: turnRequestId });

  record("mid-turn:wait", { seconds: MID_TURN_DELAY });
  await sleep(MID_TURN_DELAY * 1000);
  await subSnapshot("before-deploys");

  const versions: Array<string | null> = [];
  for (let i = 1; i <= DEPLOYS; i++) {
    const { versionId } = await runDeploy(`churn-${i}/${DEPLOYS}`);
    versions.push(versionId);
    await subSnapshot(`after-deploy-${i}`);
    if (BETWEEN > 0 && i < DEPLOYS) await sleep(BETWEEN * 1000);
  }

  record("settle:wait", { seconds: SETTLE });
  const settleDeadline = Date.now() + SETTLE * 1000;
  let lastStatus: SubAgentStatus | null = null;
  while (Date.now() < settleDeadline) {
    await sleep(3000);
    lastStatus = await subSnapshot("settling");
    if (!lastStatus) continue;
    const collected = lastStatus.parentChildStatus === "completed";
    const childDone =
      lastStatus.child != null &&
      lastStatus.child.maxIndex >= SUB_AGENT_CHILD_STEPS &&
      !lastStatus.child.hasFiberRows &&
      !lastStatus.parentHasFiberRows;
    if (collected && childDone) break;
  }

  monitor.stop();

  const child = lastStatus?.child ?? null;
  const childReRuns = child ? child.totalExecutions - child.uniqueIndices : -1;
  const collected = lastStatus?.parentChildStatus === "completed";
  const childComplete =
    child != null && child.uniqueIndices >= SUB_AGENT_CHILD_STEPS;
  // RE-ATTACHED: child ran every step exactly once-ish (re-runs bounded by
  // evictions, not ~STEPS×re-issues) AND the parent collected its real result.
  // AMPLIFIED: the parent abandoned + re-ran the child (high re-runs) or never
  // collected (parent stuck interrupted/error while child completed).
  const amplified = child != null && childReRuns >= SUB_AGENT_CHILD_STEPS;
  const verdict = {
    mode: "subagent",
    reattached: collected && childComplete && !amplified,
    amplified,
    parentChildStatus: lastStatus?.parentChildStatus ?? null,
    childRunRowCount: lastStatus?.childRunRowCount ?? null,
    childUnique: child?.uniqueIndices ?? null,
    childTotal: child?.totalExecutions ?? null,
    childReRuns,
    childRecoveries: child?.recoveryCount ?? null,
    childDuplicates: child?.duplicates ?? [],
    parentHasFiberRows: lastStatus?.parentHasFiberRows ?? null,
    incidents: lastStatus?.incidents ?? [],
    deployVersions: versions
  };
  record("verdict", verdict);

  const summary = {
    runId,
    config: {
      mode: "subagent",
      baseUrl: httpOrigin,
      agentWsUrl: AGENT_WS_URL,
      session: SESSION,
      deploys: DEPLOYS,
      midTurnDelaySeconds: MID_TURN_DELAY,
      betweenSeconds: BETWEEN,
      settleSeconds: SETTLE,
      childSteps: SUB_AGENT_CHILD_STEPS
    },
    verdict,
    finalStatus: lastStatus,
    timeline: timelinePath
  };
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

  console.log("\n──────────── VERDICT (sub-agent / #1630) ────────────");
  if (verdict.reattached) {
    console.log(
      `RE-ATTACHED: parent collected the recovered child (status=completed); child ran all ${SUB_AGENT_CHILD_STEPS} steps with ${childReRuns} re-runs (bounded by ${child?.recoveryCount ?? 0} recoveries).`
    );
  } else if (verdict.amplified) {
    console.log(
      `AMPLIFIED: child re-ran already-completed work (${childReRuns} re-runs across ${child?.uniqueIndices ?? 0} unique steps).`
    );
  } else {
    console.log(
      `INCONCLUSIVE / NOT COLLECTED: parentChildStatus=${verdict.parentChildStatus}, childUnique=${verdict.childUnique}/${SUB_AGENT_CHILD_STEPS}, childReRuns=${childReRuns}.`
    );
  }
  console.log(`\nTimeline:  ${timelinePath}`);
  console.log(`Summary:   ${summaryPath}`);
  timelineStream.end();
}

// ── main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  record("run:start", {
    baseUrl: httpOrigin,
    agentWsUrl: AGENT_WS_URL,
    session: SESSION,
    deploys: DEPLOYS,
    durationSeconds: DURATION,
    midTurnDelaySeconds: MID_TURN_DELAY,
    betweenSeconds: BETWEEN,
    settleSeconds: SETTLE,
    initialDeploy: INITIAL_DEPLOY,
    monitor: MONITOR ? CLIENT : "disabled",
    timeline: timelinePath
  });

  if (INITIAL_DEPLOY) {
    await runDeploy("initial");
    // Give the rollout a moment to become globally addressable.
    await sleep(5000);
  }

  // Clean slate so incidents/turns reflect only this run (skip with --no-reset
  // to probe an already-wedged agent without clearing its state).
  if (RESET) {
    try {
      await rpc("reset");
      record("reset:ok");
    } catch (e) {
      record("reset:error", {
        error: e instanceof Error ? e.message : String(e)
      });
    }
  } else {
    await snapshot("pre-probe");
  }

  const monitor = MONITOR ? startConnectionMonitor() : { stop: () => {} };

  const turnRequestId = await startTurn(
    `Deploy churn probe: stream a response for ${DURATION} seconds.`
  );
  record("turn:sent", { requestId: turnRequestId });

  record("mid-turn:wait", { seconds: MID_TURN_DELAY });
  await sleep(MID_TURN_DELAY * 1000);
  await snapshot("before-deploys");

  const versions: Array<string | null> = [];
  for (let i = 1; i <= DEPLOYS; i++) {
    const { versionId } = await runDeploy(`churn-${i}/${DEPLOYS}`);
    versions.push(versionId);
    await snapshot(`after-deploy-${i}`);
    if (BETWEEN > 0 && i < DEPLOYS) await sleep(BETWEEN * 1000);
  }
  const lastDeployAt = Date.now();

  record("settle:wait", { seconds: SETTLE });
  const settleDeadline = Date.now() + SETTLE * 1000;
  let lastStatus: AgentStatus | null = null;
  let selfRecovered = false;
  let exhausted = false;
  while (Date.now() < settleDeadline) {
    await sleep(3000);
    lastStatus = await snapshot("settling");
    if (!lastStatus) continue;
    if (lastStatus.exhausted) {
      exhausted = true;
      break;
    }
    // Self-recovered = a turn completed AFTER the last deploy (so it ran on
    // fresh code) with no orphaned fiber rows left behind.
    const completedAfterChurn = lastStatus.turns.some(
      (t) => t.status === "completed" && t.at > lastDeployAt
    );
    if (completedAfterChurn && !lastStatus.hasFiberRows) {
      selfRecovered = true;
      break;
    }
  }

  // The decisive probe from the report: is the DO itself wedged, or only the
  // interrupted turn? A fresh user message must complete cleanly on new code.
  const freshSentAt = Date.now();
  record("freshTurn:send");
  await startTurn("Post-churn health check: stream for 5 seconds.");
  let freshHealthy = false;
  const freshDeadline = Date.now() + 60_000;
  while (Date.now() < freshDeadline) {
    await sleep(3000);
    const status = await snapshot("fresh-check");
    if (!status) continue;
    lastStatus = status;
    const freshCompleted = status.turns.some(
      (t) => t.status === "completed" && t.at > freshSentAt
    );
    if (freshCompleted) {
      freshHealthy = true;
      break;
    }
  }

  monitor.stop();

  const verdict = {
    selfRecovered,
    exhausted,
    doHealthyAfterChurn: freshHealthy,
    orphanedFiberRows: lastStatus?.hasFiberRows ?? null,
    recoveries: lastStatus?.recoveryContexts.length ?? null,
    incidents: lastStatus?.incidents ?? [],
    chatErrors: lastStatus?.chatErrors ?? [],
    agentErrors: lastStatus?.agentErrors ?? [],
    deployVersions: versions
  };

  record("verdict", verdict);

  const summary = {
    runId,
    config: {
      baseUrl: httpOrigin,
      agentWsUrl: AGENT_WS_URL,
      session: SESSION,
      deploys: DEPLOYS,
      durationSeconds: DURATION,
      midTurnDelaySeconds: MID_TURN_DELAY,
      betweenSeconds: BETWEEN,
      settleSeconds: SETTLE
    },
    verdict,
    finalStatus: lastStatus,
    timeline: timelinePath
  };
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

  console.log("\n──────────── VERDICT ────────────");
  if (exhausted) {
    console.log(
      "RECOVERY EXHAUSTED: the interrupted turn burned its attempt budget and was abandoned."
    );
  } else if (selfRecovered) {
    console.log(
      "SELF-RECOVERED: chat recovery continued the interrupted turn after the deploy churn."
    );
  } else {
    console.log(
      "INCONCLUSIVE / STUCK: the turn neither finished nor exhausted within the settle window."
    );
  }
  console.log(
    `Durable Object health after churn (fresh message): ${
      freshHealthy ? "HEALTHY" : "DID NOT COMPLETE"
    }`
  );
  if (lastStatus?.hasFiberRows) {
    console.log("Orphaned fiber rows remain (cf_agents_runs not cleaned up).");
  }
  const chatErrors = lastStatus?.chatErrors ?? [];
  if (chatErrors.length) {
    const byStage = chatErrors.reduce<Record<string, number>>((acc, e) => {
      acc[e.stage] = (acc[e.stage] ?? 0) + 1;
      return acc;
    }, {});
    console.log(
      `Chat errors (onChatError) by stage: ${JSON.stringify(byStage)}`
    );
    console.log(
      `  last: [${chatErrors.at(-1)?.stage}] ${chatErrors.at(-1)?.message}`
    );
  }
  if (lastStatus?.agentErrors?.length) {
    console.log(`Agent errors (onError): ${lastStatus.agentErrors.length}`);
  }
  console.log(`\nTimeline:  ${timelinePath}`);
  console.log(`Summary:   ${summaryPath}`);

  timelineStream.end();
}

(MODE === "subagent" ? mainSubAgent : main)()
  .then(() => {
    // Force exit: lingering reconnect timers / sockets can keep the event loop
    // alive after the verdict is written.
    setTimeout(() => process.exit(0), 250);
  })
  .catch((e) => {
    record("run:error", { error: e instanceof Error ? e.message : String(e) });
    console.error(e);
    timelineStream.end();
    setTimeout(() => process.exit(1), 250);
  });
