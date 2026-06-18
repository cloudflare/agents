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

  // Let the stream advance a bit so multiple throttled stashes should have run,
  // then snapshot the PRE-eviction diagnostics (the post-eviction instance is
  // fresh and would report zeros).
  await sleep(2500);
  const pre = await getDebug();
  if (pre?.stashDiag) {
    const s = pre.stashDiag;
    console.log(
      `  pre-evict stash — capture.offset=${pre.capture?.eventOffset} ` +
        `attempts=${s.attempts} ok=${s.ok} failed=${s.failed} ` +
        `lastOk=${s.lastOk} lastError=${s.lastError ?? "—"}`
    );
  }

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

  console.log(
    `✓ recovery decision: reattach run ${plan.runId.slice(0, 12)}… ` +
      `(stashed offset ${plan.fromEvent}; re-attaching from 0 = full replay)`
  );

  // Wait for the continuation to finish: poll until the assistant message
  // length is STABLE across several reads (so we don't read mid-stream).
  const assistantLen = (d) =>
    (d.transcript ?? []).find((m) => m.role === "assistant")?.text?.length ?? 0;
  let prevLen = -1;
  let stableCount = 0;
  const settled = await pollUntil(
    (d) => {
      const len = assistantLen(d);
      stableCount = len > 0 && len === prevLen ? stableCount + 1 : 0;
      prevLen = len;
      return stableCount >= 3; // stable across 3 consecutive polls
    },
    { label: "turn to settle", tries: 80, intervalMs: 1000 }
  );
  console.log(
    `✓ turn converged — assistant message: ${assistantLen(settled)} chars`
  );

  // The headline proof: does the recovered message equal the FULL run?
  // Poll verify over time so a still-streaming recovery turn (race) is
  // distinguishable from a genuine stall.
  console.log("→ verify against ground-truth resume(from=0)");
  let v = null;
  for (let i = 0; i < 10; i++) {
    v = await readJson(await fetch(url("verify")));
    if (!v || v.error) {
      console.error(`✗ verify failed: ${v?.error ?? "no response"}`);
      process.exit(1);
    }
    console.log(
      `  recovered ${v.recoveredLen} / full ${v.fullLen} chars` +
        (v.match ? " — MATCH" : ` — diverge@${v.firstDivergence}`)
    );
    if (v.match) break;
    await sleep(2000);
  }

  if (v.match) {
    console.log(
      `✓ ZERO-LOSS — recovered === full run ${v.fullLen} chars ` +
        `(re-attached from event ${v.reattachedFromEvent}, zero regenerated tokens)`
    );
  } else {
    console.warn(
      `⚠ seam mismatch — recovered ${v.recoveredLen} vs full ${v.fullLen} chars, ` +
        `first divergence at index ${v.firstDivergence}.`
    );
    console.warn(`  recovered head: ${JSON.stringify(v.recoveredHead)}`);
    console.warn(`  full      head: ${JSON.stringify(v.fullHead)}`);
    console.warn(`  recovered tail: ${JSON.stringify(v.recoveredTail)}`);
    console.warn(`  full      tail: ${JSON.stringify(v.fullTail)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
