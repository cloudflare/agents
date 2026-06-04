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

async function interrupt() {
  return post("interrupt");
}

async function debug() {
  return get("debug");
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
fn().then((pass) => process.exit(pass === false ? 1 : 0));
