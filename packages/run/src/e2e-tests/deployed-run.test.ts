/**
 * DEPLOYED e2e: `@cloudflare/run` on real Cloudflare Workers (not local
 * workerd). Local workerd does not enforce production CPU/subrequest
 * accounting for Dynamic Workers, so this suite is the release evidence that
 * production isolation, resource limits, cancellation, and containment hold.
 *
 * This suite creates REAL, billable resources, so it is double-gated:
 *  1. It is only wired into the dedicated `test:e2e:deployed` script (never
 *     the default `test` run).
 *  2. The body is skipped unless `RUN_DEPLOYED_E2E=1`.
 *
 * It builds nothing itself: build `@cloudflare/run` first, then Wrangler
 * bundles `worker.ts` against `dist/`. Requires an authenticated `wrangler`
 * (run `wrangler whoami`) on a paid Workers account; with multiple accessible
 * accounts, pin the target with `CLOUDFLARE_ACCOUNT_ID`. If the account
 * fronts workers.dev with Cloudflare Access, the suite fetches a token via
 * `cloudflared access token` after deploying (the Access app only exists
 * while the Worker does); run `cloudflared access login <url>` once
 * beforehand so a session exists, or supply `CF_ACCESS_TOKEN` directly.
 *
 * Every destructive scenario is followed by a trivial clean run proving the
 * parent Worker and its Loader binding remain usable.
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(__dirname, "wrangler.deployed.jsonc");
const RUN = process.env.RUN_DEPLOYED_E2E === "1";
let accessToken = process.env.CF_ACCESS_TOKEN;

/**
 * Fetch a Cloudflare Access token for the deployed app. Only possible after
 * deploy (deleting the Worker deletes its Access app), and occasionally needs
 * a beat after deploy before the app is registered — callers retry.
 */
function tryFetchAccessToken(): string | undefined {
  try {
    const token = execSync(`cloudflared access token --app=${baseUrl} 2>&1`, {
      encoding: "utf8",
      timeout: 30_000
    }).trim();
    return token.startsWith("ey") ? token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Deploy the test Worker and return its live URL. Merges stderr into stdout
 * because wrangler prints the deployed URL across both streams depending on
 * version.
 */
function deployOnce(): string {
  const out = execSync(`npx wrangler deploy --config "${CONFIG}" 2>&1`, {
    cwd: __dirname,
    encoding: "utf8",
    timeout: 180_000,
    env: { ...process.env, CLOUDFLARE_INCLUDE_PROCESS_ENV: "true" }
  });
  console.log(out);
  const match = out.match(/https?:\/\/[^\s]+\.workers\.dev/);
  if (!match) {
    throw new Error(
      `Could not parse a workers.dev URL from deploy output:\n${out}`
    );
  }
  return match[0];
}

/** Deploy with a small retry absorbing transient deploy-API errors. */
function deploy(attempts = 3): string {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return deployOnce();
    } catch (error) {
      lastError = error;
      console.warn(
        `[deployed-e2e] deploy attempt ${attempt + 1} failed; retrying`
      );
      execSync("sleep 5");
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("wrangler deploy failed");
}

function destroy(): void {
  try {
    const out = execSync(
      `npx wrangler delete --config "${CONFIG}" --force 2>&1`,
      {
        cwd: __dirname,
        encoding: "utf8",
        input: "y\n",
        timeout: 120_000
      }
    );
    console.log(out);
  } catch (error) {
    // Never let a teardown failure mask the test result, but make the leak
    // loud so the Worker can be removed manually
    // (`wrangler delete run-e2e-deployed`).
    console.warn(
      "[deployed-e2e] failed to delete the test Worker — delete it manually:",
      error
    );
  }
}

type ScenarioReport = {
  outcome: string;
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
  causeMessage?: string;
  value?: unknown;
  elapsedMs?: number;
  settledMs?: number;
  durationsMs?: number[];
  hostStarted?: boolean;
  signalAborted?: boolean;
  reasonName?: string;
  lateOutcome?: string;
  hostInvocations?: number;
  /** Real client-side duration; in-worker clocks freeze during sync CPU. */
  realMs: number;
};

let baseUrl = "";

async function scenario(name: string): Promise<ScenarioReport> {
  const started = Date.now();
  const response = await fetch(`${baseUrl}/scenario/${name}`, {
    method: "POST",
    headers: accessToken === undefined ? {} : { "cf-access-token": accessToken }
  });
  const realMs = Date.now() - started;
  const body = (await response.json()) as Omit<ScenarioReport, "realMs">;
  console.log(`[deployed-e2e] ${name} (${realMs}ms):`, JSON.stringify(body));
  expect(response.status, `scenario ${name} crashed: ${body.message}`).toBe(
    200
  );
  return { ...body, realMs };
}

/** A trivial clean run must succeed after every destructive scenario. */
async function expectCleanRun(): Promise<void> {
  const report = await scenario("trivial");
  expect(report).toMatchObject({ outcome: "completed", value: 2 });
}

async function waitForLive(): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const report = await scenario("trivial");
      if (report.outcome === "completed") return;
    } catch {
      // Freshly created workers.dev routes can drop early requests, and an
      // Access-gated account serves HTML until a token is attached.
      if (process.env.CF_ACCESS_TOKEN === undefined) {
        accessToken = tryFetchAccessToken() ?? accessToken;
      }
    }
    if (Date.now() > deadline) {
      throw new Error("deployed route never became live");
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

describe.skipIf(!RUN)("deployed run e2e", () => {
  beforeAll(() => {
    baseUrl = deploy();
  }, 200_000);

  afterAll(() => {
    destroy();
  }, 130_000);

  it("completes a trivial run in production", async () => {
    await waitForLive();
    await expectCleanRun();
  });

  it("blocks direct outbound network access via globalOutbound null", async () => {
    const report = await scenario("blocked-fetch");
    expect(report.outcome).toBe("run-error");
    expect(report.code).toBe("RUN_EXECUTION_ERROR");
    await expectCleanRun();
  });

  it("terminates a synchronous infinite loop through the child CPU budget", async () => {
    // Production runs the child on the parent's thread: parent timers cannot
    // fire while the child spins, so the wall timeout cannot preempt a
    // synchronous loop. The configured `cpuMs` budget is the effective
    // interrupt and settles run() with RUN_RESOURCE_LIMIT; the parent stays
    // usable (clean run below).
    const report = await scenario("sync-loop");
    expect(report.outcome).toBe("run-error");
    expect(report.code).toBe("RUN_RESOURCE_LIMIT");
    expect(report.details).toMatchObject({ limit: "cpuMs" });
    // cpuMs 500 plus ~2s of production enforcement lag, well under the wall.
    expect(report.realMs).toBeLessThan(15_000);
    await expectCleanRun();
  });

  it("interrupts an asynchronously waiting child by parent wall timeout", async () => {
    const report = await scenario("wall-timeout");
    expect(report.outcome).toBe("run-error");
    expect(report.code).toBe("RUN_TIMEOUT");
    expect(report.details).toMatchObject({ limit: "timeoutMs", allowed: 2000 });
    expect(report.realMs).toBeLessThan(15_000);
    await expectCleanRun();
  });

  it("maps production CPU enforcement to RUN_RESOURCE_LIMIT before the wall timeout", async () => {
    const report = await scenario("cpu-limit");
    expect(report.outcome).toBe("run-error");
    expect(report.code).toBe("RUN_RESOURCE_LIMIT");
    expect(report.details).toMatchObject({ limit: "cpuMs" });
    // Killed near cpuMs 500 (+~2s enforcement lag), far below the 120s wall.
    expect(report.realMs).toBeLessThan(30_000);
    await expectCleanRun();
  });

  it("pins that loopback host RPC calls do not consume child subrequests", async () => {
    // Production observation (see the scenario comment): with
    // `globalOutbound: null` the child's only outbound channel is the host
    // dispatcher loopback, and those RPC calls are not counted against
    // `subRequests`. `maxHostFunctionCalls` is the effective host-call
    // protection. If this starts failing, the platform began counting
    // loopback RPC and Run must re-evaluate its limits documentation.
    const report = await scenario("subrequest-limit");
    expect(report.outcome).toBe("completed");
    expect(report.hostInvocations).toBe(50);
    await expectCleanRun();
  });

  it("aborts an active host context signal and settles promptly on cancellation", async () => {
    const report = await scenario("cancel-active-host");
    expect(report.outcome).toBe("run-error");
    expect(report.code).toBe("RUN_ABORTED");
    expect(report.hostStarted).toBe(true);
    expect(report.signalAborted).toBe(true);
    expect(report.reasonName).toBe("RunError");
    expect(report.elapsedMs).toBeLessThan(5_000);
    await expectCleanRun();
  });

  it("settles promptly despite a non-cooperative host function and contains its late rejection", async () => {
    const report = await scenario("non-cooperative-host");
    expect(report.outcome).toBe("run-error");
    expect(report.code).toBe("RUN_ABORTED");
    // Settled well before the host's 2s late rejection.
    expect(report.settledMs).toBeLessThan(1_800);
    // The late rejection fired inside the same invocation and was contained:
    // the scenario still responded normally afterwards.
    expect(report.lateOutcome).toBe("rejected");
    await expectCleanRun();
  });

  it("records the twenty-run timing baseline", async () => {
    // Durations are measured inside the parent Worker around `run()` (see
    // the scenario comment): trivial runs are I/O-bound so the clock
    // advances, and client-side timing would add the test machine's RTT.
    const report = await scenario("timing");
    expect(report.outcome).toBe("completed");
    const durations = [...(report.durationsMs ?? [])].sort((a, b) => a - b);
    expect(durations).toHaveLength(20);
    const median = ((durations[9] ?? 0) + (durations[10] ?? 0)) / 2;
    const p95 = durations[18];
    // Release evidence, not a pass/fail threshold.
    console.log(
      `[deployed-e2e] timing baseline over 20 trivial runs: median ${median}ms, p95 ${p95}ms`
    );
  });
});
