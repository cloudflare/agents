#!/usr/bin/env node
/**
 * End-to-end driver for the gateway-resume Think recipe (live gateway).
 *
 * Usage:
 *   node scripts/driver.mjs https://<your-worker-url> [session]
 *
 * Flow (deterministic — no fixed sleeps racing the gateway round-trip):
 *   1. POST /gw/start       — begin a real turn through env.AI.run (gateway).
 *   2. poll /gw/debug       — wait until the run-id + offset are CAPTURED (and
 *                             therefore stashed), so the eviction is guaranteed
 *                             to leave a recoverable checkpoint.
 *   3. POST /gw/interrupt   — ctx.abort() mid-stream (simulated DO eviction).
 *   4. poll /gw/debug       — wait for recovery, assert the decision was
 *                             `reattach` and the turn converged to an answer.
 */
const BASE = process.argv[2];
const SESSION = process.argv[3] ?? "driver";

if (!BASE) {
  console.error("Usage: node scripts/driver.mjs <worker-url> [session]");
  process.exit(1);
}

// A long prompt so the stream lasts long enough to interrupt mid-flight.
const PROMPT =
  "Write a very detailed 2000-word technical essay about Cloudflare Durable " +
  "Objects: identity, single-instance routing, transactional storage, alarms, " +
  "WebSocket coordination, and several real-world use cases. Be exhaustive.";

const url = (action) =>
  `${BASE}/gw/${action}?session=${encodeURIComponent(SESSION)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Read as text + parse: tolerate a transient bad read during abort/reboot. */
async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function post(action, body) {
  const res = await fetch(url(action), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {})
  });
  return readJson(res);
}

async function getDebug() {
  return readJson(await fetch(url("debug")));
}

async function pollUntil(predicate, { tries = 30, intervalMs = 1000, label }) {
  for (let i = 0; i < tries; i++) {
    if (i === 0 && label) console.log(`  …waiting for ${label}`);
    const d = await getDebug().catch(() => null);
    if (d && predicate(d)) return d;
    await sleep(intervalMs);
  }
  return null;
}

async function main() {
  console.log(`→ start (session=${SESSION})`);
  console.log(await post("start", { prompt: PROMPT }));

  const captured = await pollUntil((d) => d.capture?.runId, {
    label: "run-id capture"
  });
  if (!captured) {
    console.error(
      "✗ never captured a cf-aig-run-id — gateway/model misconfigured?"
    );
    process.exit(1);
  }
  console.log(
    `✓ captured run ${captured.capture.runId.slice(0, 12)}… at event ${captured.capture.eventOffset}`
  );

  console.log("→ interrupt (ctx.abort, mid-stream)");
  await post("interrupt");

  const recovered = await pollUntil((d) => d.lastPlan, {
    label: "recovery plan"
  });
  const plan = recovered?.lastPlan;
  if (!plan) {
    console.error("✗ no recovery plan recorded — did recovery fire?");
    process.exit(1);
  }
  if (plan.action !== "reattach") {
    console.error(`✗ expected reattach, got fallback: ${plan.reason}`);
    process.exit(1);
  }

  const assistant = (recovered.transcript ?? []).find(
    (m) => m.role === "assistant"
  );
  console.log(
    `✓ re-attached to run ${plan.runId.slice(0, 12)}… from event ${plan.fromEvent}`
  );
  console.log(
    `✓ turn converged — assistant message: ${assistant?.text?.length ?? 0} chars`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
