#!/usr/bin/env node
/**
 * End-to-end driver for the gateway-resume Think recipe (live gateway).
 *
 * Usage:
 *   node scripts/driver.mjs https://<your-worker-url> [session] [interruptAfterMs]
 *
 * Flow:
 *   1. POST /gw/start            — begin a real turn through env.AI.run (gateway).
 *   2. wait interruptAfterMs     — let the stream make some forward progress.
 *   3. POST /gw/interrupt        — ctx.abort() (simulated DO eviction).
 *   4. poll  /gw/debug           — wait for recovery to fire, then assert the
 *                                  decision was `reattach` and the turn converged.
 */
const BASE = process.argv[2];
const SESSION = process.argv[3] ?? "driver";
const INTERRUPT_AFTER_MS = Number(process.argv[4] ?? 1500);

if (!BASE) {
  console.error(
    "Usage: node scripts/driver.mjs <worker-url> [session] [interruptAfterMs]"
  );
  process.exit(1);
}

const url = (action) =>
  `${BASE}/gw/${action}?session=${encodeURIComponent(SESSION)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(action, body) {
  const res = await fetch(url(action), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {})
  });
  return res.json().catch(() => ({}));
}
async function get(action) {
  const res = await fetch(url(action));
  return res.json();
}

async function main() {
  console.log(`→ start (session=${SESSION})`);
  console.log(
    await post("start", {
      prompt: "Write three sentences about Durable Objects."
    })
  );

  await sleep(INTERRUPT_AFTER_MS);
  console.log(`→ interrupt after ${INTERRUPT_AFTER_MS}ms`);
  await post("interrupt");

  // Recovery fires on the next access; poll debug until a plan is recorded.
  let last;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    last = await get("debug").catch(() => null);
    if (last?.lastPlan) break;
  }

  console.log("→ debug:", JSON.stringify(last, null, 2));

  const plan = last?.lastPlan;
  if (!plan) {
    console.error("✗ no recovery plan recorded — did recovery fire?");
    process.exit(1);
  }
  if (plan.action !== "reattach") {
    console.error(`✗ expected reattach, got fallback: ${plan.reason}`);
    process.exit(1);
  }
  console.log(
    `✓ re-attached to run ${plan.runId} from event ${plan.fromEvent}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
