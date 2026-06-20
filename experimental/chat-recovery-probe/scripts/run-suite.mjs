#!/usr/bin/env node
/**
 * Opt-in deployed Think chat-recovery smoke suite.
 *
 * Deploys the probe Worker ONCE (under a unique throwaway name so it never
 * clobbers a real `chat-recovery-probe` deployment), runs a set of the proven
 * `driver.mjs` scenarios against the live `*.workers.dev` URL, and ALWAYS
 * deletes the Worker in teardown.
 *
 * This is the Layer-5 (rfc-chat-recovery-foundation) live counterpart to the
 * ai-chat `deployed-recovery.test.ts` — it proves the Think recovery invariants
 * on the REAL edge, not just under local SIGKILL.
 *
 * Creates REAL, billable resources, so it is double-gated:
 *  1. Wired only into the dedicated `test:e2e:deployed` script.
 *  2. The body is a no-op unless `RUN_DEPLOYED_E2E=1`.
 *
 * Default scenario set = the FAST, deterministic, abort-driven ones (they reset
 * the isolate with `ctx.abort()` via `/probe/interrupt`, no slow/racy real
 * redeploys):
 *   a6   HITL exemption — a parked CLIENT tool call survives churn, completes on reply
 *   a7   SERVER-tool orphan recovers via repair (NOT exempt, NOT sealed)
 *   a8   approval-requested exemption — survives churn, completes on approval
 *   idem re-submitting the same idempotencyKey does not double-run
 *
 * The real-deploy-churn scenarios (a1/a2/a4/a5/a9/rapid) are slower and managed
 * for raciness; run them manually per the README. Override the set with
 * `SCENARIOS="a6,a7"` (and add `CHURN=deploy` for the faithful real-eviction
 * variant of a6/a7/a8).
 *
 * Requires an authenticated `wrangler` (run `wrangler whoami`).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROBE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (process.env.RUN_DEPLOYED_E2E !== "1") {
  console.log(
    "[probe-suite] skipped — set RUN_DEPLOYED_E2E=1 to run (deploys a real, billable Worker)."
  );
  process.exit(0);
}

const NAME = `chat-recovery-probe-e2e-${Date.now()}`;
const SCENARIOS = (process.env.SCENARIOS ?? "a6,a7,a8,idem")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function deploy() {
  const out = execFileSync("npx", ["wrangler", "deploy", "--name", NAME], {
    cwd: PROBE_DIR,
    encoding: "utf8",
    timeout: 180_000,
    env: { ...process.env, CLOUDFLARE_INCLUDE_PROCESS_ENV: "true" }
  });
  console.log(out);
  const match = out.match(/https?:\/\/[^\s]+\.workers\.dev/);
  if (!match) {
    throw new Error(`could not parse a workers.dev URL from deploy output`);
  }
  return match[0];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A freshly-deployed `*.workers.dev` route takes a few seconds to start serving;
 * the driver scenarios assume an already-live worker, so poll the real
 * `/probe/debug` endpoint until it returns its live JSON shape before driving.
 */
async function waitForLive(base, attempts = 30, delayMs = 2000) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${base}/probe/debug?session=__probe_ready__`);
      const body = await res.json().catch(() => null);
      if (body && Array.isArray(body.incidents)) return;
    } catch {
      // Route not live / propagating yet.
    }
    await sleep(delayMs);
  }
  throw new Error(`probe route did not go live within ${attempts * delayMs}ms`);
}

function destroy() {
  try {
    const out = execFileSync(
      "npx",
      ["wrangler", "delete", "--name", NAME, "--force"],
      { cwd: PROBE_DIR, encoding: "utf8", input: "y\n", timeout: 120_000 }
    );
    console.log(out);
  } catch (error) {
    console.warn(
      `[probe-suite] failed to delete ${NAME} — delete it manually: npx wrangler delete --name ${NAME} --force\n`,
      error?.message ?? error
    );
  }
}

const results = [];
let fatal = null;

try {
  console.log(`[probe-suite] deploying ${NAME} ...`);
  const base = deploy();
  console.log(`[probe-suite] base=${base}`);
  console.log("[probe-suite] waiting for the route to go live ...");
  await waitForLive(base);
  console.log(`[probe-suite] scenarios: ${SCENARIOS.join(", ")}`);

  for (const scenario of SCENARIOS) {
    console.log(`\n[probe-suite] ── running ${scenario} ──`);
    const res = spawnSync("node", ["scripts/driver.mjs", scenario], {
      cwd: PROBE_DIR,
      stdio: "inherit",
      timeout: 600_000,
      env: {
        ...process.env,
        BASE: base,
        SESSION: `${scenario}-suite-${Date.now()}`
      }
    });
    const ok = res.status === 0;
    results.push({ scenario, ok });
    console.log(`[probe-suite] ${scenario} => ${ok ? "PASS" : "FAIL"}`);
  }
} catch (error) {
  fatal = error;
  console.error("[probe-suite] fatal:", error?.message ?? error);
} finally {
  destroy();
}

const failed = results.filter((r) => !r.ok).map((r) => r.scenario);
console.log(
  `\n[probe-suite] results: ${
    results.map((r) => `${r.scenario}=${r.ok ? "PASS" : "FAIL"}`).join(" ") ||
    "(none ran)"
  }`
);
const ok = !fatal && results.length === SCENARIOS.length && failed.length === 0;
process.exit(ok ? 0 : 1);
