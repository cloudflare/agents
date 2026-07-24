#!/usr/bin/env node
/**
 * Driver for the chat-recovery probe. Validates the #1672 assumptions against
 * the deployed worker.
 *
 * Usage:
 *   BASE=https://chat-recovery-probe.<subdomain>.workers.dev \
 *     node scripts/driver.mjs <scenario>
 *
 * Scenarios:
 *   a4         work_budget_exceeded  (runaway content + finite maxRecoveryWork)
 *   a5         recovery_aborted      (shouldKeepRecovering -> false)
 *   a2         no_progress_timeout   (stuck turn + small noProgressTimeoutMs)
 *   a6         HITL exemption        (parked client tool call survives churn,
 *                                     is NOT sealed, completes on the reply)
 *   a1-start   start the long progressing turn for the deploy-churn invariant
 *   watch      poll a session's submission + debug until terminal
 *   debug      print one debug snapshot
 *   interrupt  fire a single ctx.abort()
 *   reset      clear a session
 *
 * Per-scenario flags via env: SESSION (default: scenario name).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const execFileAsync = promisify(execFile);
const PROBE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const BASE = process.env.BASE;
if (!BASE) {
  console.error("Set BASE=https://<worker-url>");
  process.exit(1);
}

// A single stray rejection (e.g. a WebSocket `ErrorEvent` from a transient
// connect failure against a just-deployed worker) must not crash the driver
// with an opaque ERR_UNHANDLED_REJECTION. Exit non-zero with context instead.
process.on("unhandledRejection", (reason) => {
  console.error(
    "[driver] unhandledRejection:",
    reason?.stack ?? reason?.message ?? reason
  );
  process.exit(1);
});

/**
 * Real deploy = the faithful interruption for #1672: the in-flight fiber is
 * interrupted and the SAME incident is continued on restart, incrementing
 * `attempt` (where maxRecoveryWork / shouldKeepRecovering / no-progress are
 * checked). A `--var` bump forces a new version even with identical code.
 */
async function deploy() {
  const marker = String(Date.now());
  await execFileAsync(
    "npx",
    ["wrangler", "deploy", "--var", `CHURN:${marker}`],
    { cwd: PROBE_DIR, timeout: 120000 }
  );
}

const scenario = process.argv[2] ?? "debug";
const SESSION = process.env.SESSION ?? scenario;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retry a flaky async op with linear backoff. The probe runs against a freshly
 *  deployed `*.workers.dev` route, so the first calls can transiently fail
 *  while the worker/DO warms up. */
async function withRetry(label, op, { tries = 5, baseMs = 1000 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await op();
    } catch (error) {
      lastErr = error;
      const waitMs = baseMs * (i + 1);
      console.warn(
        `  [retry] ${label} failed (attempt ${i + 1}/${tries}): ${
          error?.message ?? error
        }; retrying in ${waitMs}ms`
      );
      await sleep(waitMs);
    }
  }
  throw new Error(
    `${label} failed after ${tries} attempts: ${lastErr?.message ?? lastErr}`
  );
}

async function post(action, body) {
  const res = await fetch(`${BASE}/probe/${action}?session=${SESSION}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {})
  });
  return res.json().catch(() => ({ status: res.status }));
}

async function get(action, params = "") {
  const res = await fetch(
    `${BASE}/probe/${action}?session=${SESSION}${params}`
  );
  return res.json().catch(() => ({ status: res.status }));
}

async function startChat(opts) {
  return post("start-chat", opts);
}

/**
 * POST /probe/start and assert the turn was actually accepted. A cold,
 * just-deployed worker can transiently 500 here; the worker returns an
 * `{ error }` shape (HTTP 500) that otherwise looks like a successful submit
 * with `synth`/`submissionId` undefined and silently decays into a 60s
 * "progress:0" timeout downstream. Fail loudly with the server's error instead.
 */
async function startTurn(body) {
  const res = await post("start", body);
  if (!res || res.error || !res.submissionId) {
    throw new Error(
      `/probe/start did not accept the turn: ${JSON.stringify(res)}`
    );
  }
  return res;
}

// ── WebSocket (the a6 HITL scenario acts as the SPA) ──────────────
// A pending CLIENT tool call only exists when a real chat request registers the
// tool via `clientTools` and the client later replays a `cf_agent_tool_result`.
// The HTTP control surface can't do that, so a6 speaks the use-chat WS protocol.

const HITL_TOOL_NAME = "ask_user"; // must match synthetic-model.ts
const HITL_TOOL_CALL_ID = "ask-user-call-1";
const HITL_CLIENT_TOOLS = [
  { name: HITL_TOOL_NAME, description: "Ask the human a question." }
];

function wsUrl() {
  return `${BASE.replace(/^http/, "ws")}/agents/probe-agent/${SESSION}`;
}

function openWSOnce() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl());
    ws.addEventListener("open", () => resolve(ws), { once: true });
    // Normalize the undici `ErrorEvent` into a real `Error` — a bare
    // ErrorEvent rejection surfaces as the useless reason "#<_ErrorEvent>".
    ws.addEventListener(
      "error",
      (e) =>
        reject(
          new Error(
            `WebSocket open failed: ${
              e?.message ?? e?.error?.message ?? "connection error"
            }`
          )
        ),
      { once: true }
    );
  });
}

/** Open a WS to the agent route, tolerating transient connect failures against
 *  a just-deployed route. */
function openWS() {
  return withRetry("openWS", openWSOnce, { tries: 5, baseMs: 1000 });
}

function sendChat(ws, text, clientTools) {
  ws.send(
    JSON.stringify({
      type: "cf_agent_use_chat_request",
      id: crypto.randomUUID(),
      init: {
        method: "POST",
        body: JSON.stringify({
          messages: [
            {
              id: `u-${Date.now()}`,
              role: "user",
              parts: [{ type: "text", text }]
            }
          ],
          clientTools
        })
      }
    })
  );
}

function sendToolResult(ws, output) {
  // `autoContinue: true` is what a real SPA (useAgentChat) sends — it drives the
  // continuation that consumes the tool result and finishes the turn. Without
  // it the result is applied but the turn never resumes.
  ws.send(
    JSON.stringify({
      type: "cf_agent_tool_result",
      toolCallId: HITL_TOOL_CALL_ID,
      toolName: HITL_TOOL_NAME,
      output,
      autoContinue: true,
      clientTools: HITL_CLIENT_TOOLS
    })
  );
}

function sendApproval(ws, toolCallId, approved) {
  ws.send(
    JSON.stringify({
      type: "cf_agent_tool_approval",
      toolCallId,
      approved,
      autoContinue: true
    })
  );
}

function closeWS(ws) {
  try {
    ws.close();
  } catch {
    // already closed
  }
}

async function interrupt() {
  return post("interrupt");
}

async function debug() {
  return get("debug");
}

async function primeSeal() {
  return post("prime-seal");
}

function summarize(d) {
  return {
    progress: d.progress,
    incidents: (d.incidents ?? []).map((i) => ({
      attempt: i.attempt,
      status: i.status,
      reason: i.reason,
      progress: i.progress,
      workBaseline: i.workBaseline
    })),
    exhausted: d.exhausted,
    submissions: (d.submissions ?? []).map((s) => ({
      id: s.submissionId?.slice(0, 8),
      status: s.status
    }))
  };
}

/** Poll debug until an exhausted row appears or the submission is terminal. */
async function waitForOutcome(submissionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const d = await debug();
    last = d;
    const ex = d.exhausted?.[0];
    if (ex) return { kind: "exhausted", reason: ex.reason, debug: d };
    const sub = (d.submissions ?? []).find(
      (s) => s.submissionId === submissionId
    );
    if (sub && (sub.status === "completed" || sub.status === "error")) {
      return { kind: sub.status, debug: d };
    }
    await sleep(3000);
  }
  return { kind: "timeout", debug: last };
}

/**
 * Budgets/predicate/no-progress are evaluated at the START of each recovery
 * attempt, and an attempt only fires on an interruption. Drive repeated REAL
 * deploys (each followed by a debug poll window so recovery advances) until a
 * seal appears or the submission goes terminal.
 */
async function driveDeploys(submissionId, { gapMs, max, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  for (let i = 0; i < max && Date.now() < deadline; i++) {
    console.log(`  deploy ${i + 1}/${max} ...`);
    await deploy();
    const stepDeadline = Date.now() + gapMs;
    while (Date.now() < stepDeadline) {
      const d = await debug();
      const ex = d.exhausted?.[0];
      if (ex) return { kind: "exhausted", reason: ex.reason, debug: d };
      const sub = (d.submissions ?? []).find(
        (s) => s.submissionId === submissionId
      );
      if (sub && (sub.status === "completed" || sub.status === "error")) {
        return { kind: sub.status, debug: d };
      }
      await sleep(4000);
    }
  }
  return waitForOutcome(submissionId, Math.max(deadline - Date.now(), 1000));
}

function report(name, expected, outcome) {
  const got = outcome.kind === "exhausted" ? outcome.reason : outcome.kind;
  const pass = got === expected;
  console.log(
    `\n[${name}] expected=${expected} got=${got} => ${pass ? "PASS" : "FAIL"}`
  );
  console.log(JSON.stringify(summarize(outcome.debug), null, 2));
  return pass;
}

async function scenarioA4() {
  await post("reset");
  await startChat({
    synth: { mode: "runaway", intervalMs: 1500, targetSteps: 0 },
    recovery: { maxRecoveryWork: 5, maxAttempts: 50 }
  });
  console.log("a4 started (chat path)");
  await sleep(6000); // let it produce a few ticks first
  const outcome = await driveDeploys(null, {
    gapMs: 15000,
    max: 6,
    timeoutMs: 360000
  });
  return report("A4 work_budget_exceeded", "work_budget_exceeded", outcome);
}

async function scenarioA5() {
  await post("reset");
  await startChat({
    synth: { mode: "progress", intervalMs: 1500, targetSteps: 1000 },
    recovery: { abortAfterAttempt: 2, maxAttempts: 50 }
  });
  console.log("a5 started (chat path)");
  await sleep(5000);
  const outcome = await driveDeploys(null, {
    gapMs: 15000,
    max: 6,
    timeoutMs: 360000
  });
  return report("A5 recovery_aborted", "recovery_aborted", outcome);
}

async function scenarioA2() {
  await post("reset");
  await startChat({
    synth: { mode: "stuck", intervalMs: 1500, targetSteps: 0 },
    recovery: { noProgressTimeoutMs: 45000, maxAttempts: 50 }
  });
  console.log("a2 started (chat path)");
  await sleep(5000);
  const outcome = await driveDeploys(null, {
    gapMs: 20000,
    max: 8,
    timeoutMs: 360000
  });
  return report("A2 no_progress_timeout", "no_progress_timeout", outcome);
}

const completedCount = (d) => (d.completed ?? []).length;
const hasSeal = (d) => (d.exhausted ?? []).length > 0;
const sealOutcome = (d) => ({
  kind: "exhausted",
  reason: d.exhausted[0].reason,
  debug: d
});

/** Poll debug until `lastClientTools` is registered (the priming turn landed). */
async function waitForClientTools(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const d = await debug();
    if (d.lastClientTools && d.lastClientTools.length > 0) return d;
    await sleep(1500);
  }
  throw new Error("clientTools were never registered by the priming turn");
}

/** Poll debug until the turn is parked on a pending interaction (an
 *  `input-available` client tool or an `approval-requested` part). */
async function waitForParked(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const d = await debug();
    const parked = (d.transcript ?? []).some(
      (m) =>
        m.role === "assistant" &&
        (m.parts ?? []).some(
          (p) =>
            p.state === "input-available" || p.state === "approval-requested"
        )
    );
    if (parked) return d;
    await sleep(2000);
  }
  throw new Error("turn never parked on a pending interaction");
}

/** True if any incident was parked as a pending client interaction. */
const wasExempted = (d) =>
  (d.incidents ?? []).some((i) => i.reason === "awaiting_client_interaction");

/** Poll debug until the turn completes (a new completion past `baseline`) or seals. */
async function waitForCompletionAfter(baseline, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const d = await debug();
    last = d;
    if (hasSeal(d)) return sealOutcome(d);
    if (completedCount(d) > baseline) return { kind: "completed", debug: d };
    await sleep(3000);
  }
  return { kind: "timeout", debug: last };
}

/**
 * A6 — a HITL turn parked on a pending CLIENT interaction must survive deploy
 * churn (the customer's "session interrupted" symptom) and complete once the
 * human replies.
 *
 * Why the submitMessages path: only a `submitMessages` turn leaves a durable
 * `running` submission that the next isolate's boot-recovery sweep picks up. The
 * OLD behavior recovered that running submission, found `waitUntilStable` timing
 * out (the human hasn't answered), and sealed the healthy turn — marking the
 * submission `error` (`stable_timeout` / `no_progress_timeout`). The fix marks
 * the submission COMPLETED at park and PARKS recovery
 * (`awaiting_client_interaction`), so eviction can't resurrect it as an error.
 *
 * `clientTools` only attach via a real chat request, so we PRIME them with a
 * quick non-HITL WS turn, then submit the HITL turn.
 */
async function scenarioA6() {
  await post("reset");

  // 1. Prime `ask_user` as a client tool via a quick non-HITL WS turn.
  await post("config", {
    synth: { mode: "progress", targetSteps: 1, intervalMs: 50 }
  });
  let ws = await openWS();
  sendChat(ws, "priming clientTools", HITL_CLIENT_TOOLS);
  await waitForClientTools();
  closeWS(ws);
  console.log("a6: clientTools primed (ask_user)");

  // 2. Submit the HITL turn. Tight budget so the PRE-FIX build seals within the
  //    churn window; the FIXED build completes the submission at park, so these
  //    bounds never bite.
  const start = await startTurn({
    synth: { mode: "hitl" },
    recovery: {
      noProgressTimeoutMs: 20000,
      maxAttempts: 2,
      stableTimeoutMs: 4000
    }
  });
  console.log(`a6: submitted (mode=${start.synth?.mode})`);

  // 3. Wait until the turn parks on the pending client tool call.
  await waitForParked();
  console.log("a6: parked on pending client tool call");

  // 4. Churn the isolate past the recovery budget while the human stays silent.
  //    CHURN=deploy uses real `wrangler deploy` (the faithful eviction, slower);
  //    default is `ctx.abort()` (equally faithful isolate reset, fast). The
  //    debug poll between rounds re-instantiates the DO, driving boot recovery.
  const useDeploy = process.env.CHURN === "deploy";
  const rounds = useDeploy ? 3 : 2;
  for (let i = 0; i < rounds; i++) {
    console.log(
      `  a6 ${useDeploy ? "deploy" : "interrupt"} ${i + 1}/${rounds} ...`
    );
    if (useDeploy) await deploy();
    else await interrupt();
    await sleep(useDeploy ? 4000 : 8000);
    const d = await debug();
    if (hasSeal(d))
      return report("A6 HITL recovery exemption", "completed", sealOutcome(d));
  }
  // Sit idle past the no-progress window — the reschedule loop (pre-fix) would
  // seal here; the fix has parked it, so nothing should change.
  console.log("  a6 idling past the no-progress window (no human reply) ...");
  await sleep(25000);
  const idle = await debug();
  if (hasSeal(idle))
    return report("A6 HITL recovery exemption", "completed", sealOutcome(idle));
  const baseline = completedCount(idle);

  // 5. The human finally answers — reconnect and replay the tool result
  //    (`autoContinue: true` drives the continuation that finishes the turn).
  console.log("a6: replaying tool result (human answers) ...");
  ws = await openWS();
  sendToolResult(ws, "approved");

  // 6. The continuation must complete the turn (no seal).
  const outcome = await waitForCompletionAfter(baseline);
  closeWS(ws);
  return report("A6 HITL recovery exemption", "completed", outcome);
}

/**
 * Evict the isolate a few times past the recovery budget. CHURN=deploy uses real
 * `wrangler deploy` (faithful eviction, slower); default is `ctx.abort()` (fast).
 * The debug poll between rounds re-instantiates the DO, driving boot recovery.
 * Returns the sealing debug snapshot if a seal appeared, else null.
 */
async function churnRounds(tag) {
  const useDeploy = process.env.CHURN === "deploy";
  const rounds = useDeploy ? 3 : 2;
  for (let i = 0; i < rounds; i++) {
    console.log(
      `  ${tag} ${useDeploy ? "deploy" : "interrupt"} ${i + 1}/${rounds} ...`
    );
    if (useDeploy) await deploy();
    else await interrupt();
    await sleep(useDeploy ? 4000 : 8000);
    const d = await debug();
    if (hasSeal(d)) return d;
  }
  return null;
}

/**
 * A7 — a SERVER-tool orphan must NOT be exempted. `slow_server`'s `execute`
 * dies with the evicted isolate, so nothing will ever resolve it. Recovery must
 * REPAIR it (errored tool result) and CONTINUE to completion — NOT park it as a
 * pending interaction (`awaiting_client_interaction`) and NOT seal it. This
 * guards the exemption from being too broad (the symmetric counterpart of a6).
 */
async function scenarioA7() {
  await post("reset");
  const start = await startTurn({
    synth: { mode: "server-orphan" },
    recovery: {
      noProgressTimeoutMs: 15000,
      maxAttempts: 2,
      stableTimeoutMs: 4000
    }
  });
  console.log(`a7: submitted (mode=${start.synth?.mode})`);
  await sleep(4000); // server tool is now executing

  const sealed = await churnRounds("a7");
  if (sealed)
    return report(
      "A7 server-orphan recovers (not exempt)",
      "completed",
      sealOutcome(sealed)
    );

  const outcome = await waitForCompletionAfter(0);
  // Scoping assertion: a server orphan must recover via repair, never via the
  // client-interaction park.
  if (outcome.kind === "completed" && wasExempted(outcome.debug)) {
    return report("A7 server-orphan recovers (not exempt)", "completed", {
      kind: "wrongly-exempted-as-client-interaction",
      debug: outcome.debug
    });
  }
  return report("A7 server-orphan recovers (not exempt)", "completed", outcome);
}

/**
 * A8 — the approval-requested HITL variant. A turn parked on a server tool's
 * `approval-requested` (here `approve_action`, `needsApproval`) is also WAITING
 * ON THE HUMAN and is recovery-exempt regardless of `clientTools`. It must
 * survive churn without sealing and complete once the approval is replayed over
 * `cf_agent_tool_approval`.
 */
async function scenarioA8() {
  await post("reset");
  const start = await startTurn({
    synth: { mode: "approval" },
    recovery: {
      noProgressTimeoutMs: 20000,
      maxAttempts: 2,
      stableTimeoutMs: 4000
    }
  });
  console.log(`a8: submitted (mode=${start.synth?.mode})`);

  await waitForParked();
  console.log("a8: parked on approval-requested");

  const sealed = await churnRounds("a8");
  if (sealed)
    return report(
      "A8 approval-requested exemption",
      "completed",
      sealOutcome(sealed)
    );

  console.log("  a8 idling past the no-progress window (no approval) ...");
  await sleep(25000);
  const idle = await debug();
  if (hasSeal(idle))
    return report(
      "A8 approval-requested exemption",
      "completed",
      sealOutcome(idle)
    );
  const baseline = completedCount(idle);

  // The human finally approves — reconnect and replay the approval.
  console.log("a8: replaying approval (human approves) ...");
  const ws = await openWS();
  sendApproval(ws, "approve-action-call-1", true); // matches TOOL_PARK_MODES.approval
  const outcome = await waitForCompletionAfter(baseline);
  closeWS(ws);
  return report("A8 approval-requested exemption", "completed", outcome);
}

/**
 * RAPID — `onExhausted` fires exactly ONCE under a REAL-deploy storm, and the
 * terminal incident is NEVER re-emitted by later evictions.
 *
 * The hard part is making the seal DETERMINISTIC. Driving a live turn to a
 * natural seal under churn is racy: a content-emitting `runaway` advances the
 * conversation leaf, so its budget seal is lost to a `conversation_changed`
 * skip in the CONTINUATION path; a `stuck` turn emits nothing and is dropped as
 * non-recoverable on attempt 1, so the no-progress clock never accrues. Both
 * depend on alarm/deploy timing.
 *
 * So we SEED the seal instead (see `/probe/prime-seal`):
 *   1. Start a `runaway` turn with a small `maxRecoveryWork` — this produces a
 *      genuinely recoverable chat fiber (real partial content) that keeps
 *      running across restarts.
 *   2. One real deploy lets boot recovery open the incident with the CORRECT
 *      id/key (so we don't have to reconstruct the internal user-message id).
 *   3. `prime-seal` rewrites that incident's `workBaseline` to 0, so the next
 *      detection sees `work = progress > maxRecoveryWork` and seals via the
 *      RACE-FREE boot path (`_handleInternalFiberRecovery` decides exhaustion
 *      BEFORE scheduling any continuation — no `conversation_changed` window).
 *   4. One deploy interrupts the still-live fiber → boot recovery re-detects
 *      it → seals exactly once (`work_budget_exceeded`) and CONSUMES the fiber.
 *   5. HAMMER more deploys: with the fiber consumed there is nothing to
 *      re-detect, so `onExhausted` must not fire again.
 *
 * Pass = exactly one `exhausted` row with reason `work_budget_exceeded` after
 * the whole storm.
 */
async function scenarioRapid() {
  await post("reset");
  await startChat({
    synth: { mode: "runaway", intervalMs: 1500, targetSteps: 0 },
    recovery: { maxRecoveryWork: 2, maxAttempts: 50 }
  });
  console.log("rapid: runaway turn started (recoverable fiber)");
  await sleep(6000); // let it produce a few ticks (progress > maxRecoveryWork)

  // 1 deploy: boot recovery opens the incident with the correct id/key.
  console.log("  rapid: deploy #1 — let boot recovery open the incident ...");
  await deploy();
  await sleep(10000); // let the continuation resume the runaway fiber
  const opened = await debug();
  if ((opened.incidents ?? []).length === 0) {
    console.log("\n[RAPID onExhausted-once] no incident opened => FAIL");
    console.log(JSON.stringify(summarize(opened), null, 2));
    return false;
  }

  // Prime the incident so the NEXT detection seals via work_budget_exceeded.
  const primed = await primeSeal();
  console.log(`  rapid: primed ${primed.primed} incident(s) to seal`);

  // 1 deploy: interrupts the live fiber → boot path seals EXACTLY once.
  console.log("  rapid: deploy #2 — should seal once at the boot path ...");
  await deploy();
  await sleep(10000);
  const afterSeal = await debug();
  if ((afterSeal.exhausted ?? []).length === 0) {
    console.log(
      "\n[RAPID onExhausted-once] primed incident did not seal => FAIL"
    );
    console.log(JSON.stringify(summarize(afterSeal), null, 2));
    return false;
  }

  // HAMMER: prove the consumed fiber is never re-detected / re-sealed.
  console.log(
    "  rapid: sealed — hammering 4x to check for duplicate seals ..."
  );
  for (let i = 0; i < 4; i++) {
    console.log(`    post-seal deploy ${i + 1}/4 ...`);
    await deploy();
    await sleep(6000);
  }
  await sleep(8000);
  const d = await debug();
  const n = (d.exhausted ?? []).length;
  const reason = d.exhausted?.[0]?.reason;
  const pass = n === 1 && reason === "work_budget_exceeded";
  console.log(
    `\n[RAPID onExhausted-once] exhausted=${n} reason=${reason} => ${pass ? "PASS" : "FAIL"}`
  );
  console.log(JSON.stringify(summarize(d), null, 2));
  return pass;
}

/**
 * IDEM — re-submitting the same `idempotencyKey` does not double-run. Set
 * CHURN=deploy to insert a real deploy between the two submits (cross-eviction
 * idempotency). Asserts a single submission and a single completion.
 */
async function scenarioIdem() {
  await post("reset");
  const key = "idem-key-1";
  const synth = { mode: "progress", targetSteps: 6, intervalMs: 1500 };
  const r1 = await startTurn({ synth, idempotencyKey: key });
  console.log(
    `idem: submit#1 id=${r1.submissionId?.slice(0, 8)} accepted=${r1.accepted}`
  );
  await sleep(2000);
  if (process.env.CHURN === "deploy") {
    console.log("  idem: deploy between submits ...");
    await deploy();
    await sleep(3000);
  }
  // A real client retry resends the SAME submissionId + idempotencyKey.
  const r2 = await startTurn({
    synth,
    submissionId: r1.submissionId,
    idempotencyKey: key
  });
  console.log(
    `idem: submit#2 id=${r2.submissionId?.slice(0, 8)} accepted=${r2.accepted}`
  );

  await sleep(20000); // let the (single) turn finish
  const d = await debug();
  const subs = d.submissions ?? [];
  const sameId = r1.submissionId === r2.submissionId;
  const oneSub = subs.length === 1;
  const completions = (d.completed ?? []).length;
  const pass = sameId && oneSub && completions === 1 && !r2.accepted;
  console.log(
    `\n[IDEM idempotency] sameId=${sameId} subs=${subs.length} completions=${completions} r2.accepted=${r2.accepted} => ${pass ? "PASS" : "FAIL"}`
  );
  console.log(JSON.stringify(summarize(d), null, 2));
  return pass;
}

/**
 * A9 — deploy landing DURING a recovery continuation. A tight deploy storm
 * (short gaps) maximizes the chance a deploy evicts the isolate while
 * `_chatRecoveryContinue` is mid-flight, exercising the non-idempotent
 * reschedule / one-shot alarm-row race. A progressing turn must still converge
 * to completion, with no spurious seal and no zombie "recovering…" indicator.
 */
async function scenarioA9() {
  await post("reset");
  await startChat({
    synth: { mode: "progress", targetSteps: 20, intervalMs: 2000 },
    recovery: {}
  });
  console.log("a9: progress turn started (deploy storm follows)");
  for (let i = 0; i < 5; i++) {
    console.log(`  a9 deploy ${i + 1}/5 ...`);
    await deploy();
    await sleep(3000); // short gap → likely lands mid-recovery
    const d = await debug();
    if ((d.completed ?? []).length > 0 || hasSeal(d)) break;
  }
  // Let it converge.
  const deadline = Date.now() + 120000;
  let d = await debug();
  while (Date.now() < deadline) {
    d = await debug();
    if ((d.completed ?? []).length > 0 || hasSeal(d)) break;
    await sleep(5000);
  }
  const completed = (d.completed ?? []).length > 0;
  const zombie = !!d.recovering && completed;
  const pass = completed && !hasSeal(d) && !zombie;
  console.log(
    `\n[A9 deploy-during-recovery] completed=${completed} sealed=${hasSeal(d)} recovering=${!!d.recovering} => ${pass ? "PASS" : "FAIL"}`
  );
  console.log(JSON.stringify(summarize(d), null, 2));
  return pass;
}

async function a1Start() {
  await post("reset");
  // ~18 min of steady progress at 3s/tick (longer with interruptions). Drive
  // deploys separately (scripts/churn.sh) and watch with `driver.mjs watch`.
  const r = await startChat({
    synth: { mode: "progress", intervalMs: 3000, targetSteps: 360 },
    recovery: {} // defaults: maxRecoveryWork Infinity, 5-min no-progress
  });
  console.log("A1 long turn started:", JSON.stringify(r, null, 2));
  console.log(
    `\nNow drive deploy churn, then: SESSION=${SESSION} node scripts/driver.mjs watch`
  );
}

function oldestIncidentAgeMin(d) {
  const firsts = (d.incidents ?? [])
    .map((i) => i.firstSeenAt)
    .filter((n) => typeof n === "number");
  if (firsts.length === 0) return 0;
  return (Date.now() - Math.min(...firsts)) / 60000;
}

async function watch() {
  while (true) {
    const d = await debug();
    console.log(
      new Date().toISOString(),
      JSON.stringify({
        ...summarize(d),
        completed: (d.completed ?? []).length,
        ageMin: Number(oldestIncidentAgeMin(d).toFixed(1))
      })
    );
    const ex = d.exhausted?.[0];
    if (ex) {
      console.log(
        `\n>>> SEALED: reason=${ex.reason} (A1 expects NO seal) => FAIL`
      );
      return;
    }
    if ((d.completed ?? []).length > 0) {
      console.log("\n>>> COMPLETED — A1 invariant holds (survived churn).");
      return;
    }
    await sleep(10000);
  }
}

/** Integrated A1: start + slow real-deploy churn past 15 min + assert. */
async function a1() {
  await a1Start();
  const deploys = Number(process.env.COUNT ?? 6);
  const intervalMs = Number(process.env.INTERVAL ?? 200) * 1000;
  for (let i = 0; i < deploys; i++) {
    const stepDeadline = Date.now() + intervalMs;
    while (Date.now() < stepDeadline) {
      const d = await debug();
      if ((d.exhausted ?? []).length > 0) {
        console.log(`\n>>> SEALED: ${d.exhausted[0].reason} => A1 FAIL`);
        return false;
      }
      if ((d.completed ?? []).length > 0) {
        console.log(
          `\n>>> COMPLETED after ${i} deploys, oldest incident age ${oldestIncidentAgeMin(d).toFixed(1)}min => A1 PASS`
        );
        return true;
      }
      await sleep(8000);
    }
    console.log(`  A1 deploy ${i + 1}/${deploys} ...`);
    await deploy();
  }
  return watch().then(() => undefined);
}

const scenarios = {
  a4: scenarioA4,
  a5: scenarioA5,
  a2: scenarioA2,
  a6: scenarioA6,
  a7: scenarioA7,
  a8: scenarioA8,
  a9: scenarioA9,
  rapid: scenarioRapid,
  idem: scenarioIdem,
  a1,
  "a1-start": a1Start,
  watch,
  interrupt: async () => console.log(await interrupt()),
  reset: async () => console.log(await post("reset")),
  debug: async () => console.log(JSON.stringify(await debug(), null, 2))
};

const fn = scenarios[scenario];
if (!fn) {
  console.error(`Unknown scenario: ${scenario}`);
  process.exit(1);
}
fn()
  .then((pass) => process.exit(pass === false ? 1 : 0))
  .catch((error) => {
    console.error(
      `[driver] scenario "${scenario}" threw:`,
      error?.stack ?? error?.message ?? error
    );
    process.exit(1);
  });
