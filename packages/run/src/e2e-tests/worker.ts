/**
 * Deployed e2e parent Worker for `@cloudflare/run`.
 *
 * Deployed by `wrangler.deployed.jsonc` with a real Worker Loader binding.
 * Each POST /scenario/<name> request executes one scenario with the BUILT
 * package (the `@cloudflare/run` self-reference resolves to `dist/`) and
 * returns a JSON report the deployed test asserts against. Build the package
 * before deploying.
 */
import { getHostFunctionContext, run, RunError } from "@cloudflare/run";

interface Env {
  LOADER: WorkerLoader;
}

type ScenarioReport = Record<string, unknown>;

/** Map a settled failure into a JSON-safe report fragment. */
function reportFailure(cause: unknown): ScenarioReport {
  if (cause instanceof RunError) {
    return {
      outcome: "run-error",
      code: cause.code,
      message: cause.message,
      details: cause.details,
      // Trusted parent-side diagnostic evidence for the deployed suite.
      causeMessage: cause.cause === undefined ? undefined : String(cause.cause)
    };
  }
  return { outcome: "unexpected-error", message: String(cause) };
}

/** Execute one trivial run and report its outcome and duration. */
async function runTrivial(env: Env): Promise<ScenarioReport> {
  const started = Date.now();
  const result = await run<number>({
    loader: env.LOADER,
    source: "return 1 + 1;"
  });
  return {
    outcome: "completed",
    value: result.value,
    elapsedMs: Date.now() - started
  };
}

const scenarios: Record<string, (env: Env) => Promise<ScenarioReport>> = {
  /** Clean-run probe used between destructive scenarios. */
  trivial: runTrivial,

  /** 1. `globalOutbound: null` blocks direct network access. */
  async "blocked-fetch"(env) {
    return run<number>({
      loader: env.LOADER,
      source: `
const response = await fetch("https://example.com/");
return response.status;
`
    }).then(
      (result) => ({ outcome: "completed", value: result.value }),
      (cause: unknown) => reportFailure(cause)
    );
  },

  /**
   * 2. A synchronous infinite loop cannot hang `run()`. Production runs the
   * child on the parent's thread, so parent timers (the wall timeout) cannot
   * fire while the child spins; the child `cpuMs` budget is the effective
   * interrupt and surfaces as RUN_RESOURCE_LIMIT. In-worker Date.now() is
   * frozen during synchronous execution, so the test measures real time
   * client-side.
   */
  async "sync-loop"(env) {
    return run({
      loader: env.LOADER,
      source: "for (;;) {}",
      limits: { cpuMs: 500, timeoutMs: 60_000 }
    }).then(
      () => ({ outcome: "completed" as const }),
      (cause: unknown) => reportFailure(cause)
    );
  },

  /** 2b. The parent wall timeout interrupts an asynchronously waiting child. */
  async "wall-timeout"(env) {
    return run({
      loader: env.LOADER,
      source: "await new Promise((resolve) => setTimeout(resolve, 60_000));",
      limits: { timeoutMs: 2_000 }
    }).then(
      () => ({ outcome: "completed" as const }),
      (cause: unknown) => reportFailure(cause)
    );
  },

  /**
   * 3. A finite CPU-bound program exceeds a low child CPU limit before its
   * longer wall timeout. Production enforces `cpuMs` with roughly two seconds
   * of lag, so the program must carry tens of seconds of CPU work to prove
   * the kill rather than finishing under the enforcement checkpoint.
   */
  async "cpu-limit"(env) {
    return run({
      loader: env.LOADER,
      source: `
let total = 0;
for (let index = 0; index < 10_000_000_000; index++) {
  total += Math.sqrt(index);
}
return total;
`,
      limits: { cpuMs: 500, timeoutMs: 120_000 }
    }).then(
      () => ({ outcome: "completed" as const }),
      (cause: unknown) => reportFailure(cause)
    );
  },

  /**
   * 4. Documents production behavior: loopback host-function RPC calls do NOT
   * consume the child's `subRequests` budget (the child has no other outbound
   * channel under `globalOutbound: null`). The package-owned
   * `maxHostFunctionCalls` limit is the effective host-call protection. This
   * scenario pins that observation; if the platform starts counting loopback
   * RPC, the deployed test fails loudly and Run must re-evaluate.
   */
  async "subrequest-limit"(env) {
    let invocations = 0;
    const report = await run({
      loader: env.LOADER,
      source: `
for (let index = 0; index < 50; index++) {
  await tools.ping(index);
}
return "completed all host calls";
`,
      hostFunctions: {
        tools: {
          ping(value: number): number {
            invocations += 1;
            return value;
          }
        }
      },
      limits: { subRequests: 5, timeoutMs: 60_000 }
    }).then(
      () => ({ outcome: "completed" as const }),
      (cause: unknown) => reportFailure(cause)
    );
    return { ...report, hostInvocations: invocations };
  },

  /** 5. Caller cancellation aborts an active host context signal promptly. */
  async "cancel-active-host"(env) {
    const controller = new AbortController();
    const observed = {
      hostStarted: false,
      signalAborted: false,
      reasonName: ""
    };
    // Abort only after the host call has installed its abort listener, so
    // the scenario never races Dynamic Worker startup.
    let releaseAbort: () => void = () => undefined;
    const hostListening = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });
    // Settlement is measured from the abort moment so the duration excludes
    // Dynamic Worker startup latency.
    let abortedAt = 0;
    const aborted = hostListening.then(() => {
      abortedAt = Date.now();
      controller.abort(new Error("deployed cancellation"));
    });
    const report = await run({
      loader: env.LOADER,
      source: "return await tools.wait();",
      signal: controller.signal,
      hostFunctions: {
        tools: {
          async wait(): Promise<boolean> {
            observed.hostStarted = true;
            const context = getHostFunctionContext();
            await new Promise<void>((resolve) => {
              context.signal.addEventListener(
                "abort",
                () => {
                  observed.signalAborted = true;
                  observed.reasonName =
                    context.signal.reason instanceof Error
                      ? context.signal.reason.name
                      : String(context.signal.reason);
                  resolve();
                },
                { once: true }
              );
              releaseAbort();
            });
            return true;
          }
        }
      }
    }).then(
      () => ({ outcome: "completed" as const }),
      (cause: unknown) => reportFailure(cause)
    );
    const settledAt = Date.now();
    // Idempotent: guarantees the abort chain settles even if the host call
    // never started (e.g. an earlier failure), keeping the scenario total.
    releaseAbort();
    await aborted;
    const elapsedMs = abortedAt === 0 ? -1 : settledAt - abortedAt;
    // Give the cooperative host observer a beat to record the abort.
    await new Promise((resolve) => setTimeout(resolve, 250));
    return { ...report, elapsedMs, ...observed };
  },

  /** 6. A non-cooperative host function does not delay settlement. */
  async "non-cooperative-host"(env) {
    const controller = new AbortController();
    let lateOutcome = "pending";
    // Abort only after the non-cooperative host call has started, so the
    // scenario never races Dynamic Worker startup.
    let releaseAbort: () => void = () => undefined;
    const hostStarted = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });
    // Settlement is measured from the abort moment so the duration excludes
    // Dynamic Worker startup latency.
    let abortedAt = 0;
    const aborted = hostStarted.then(() => {
      abortedAt = Date.now();
      controller.abort(new Error("deployed cancellation"));
    });
    const report = await run({
      loader: env.LOADER,
      source: "return await tools.wait();",
      signal: controller.signal,
      hostFunctions: {
        tools: {
          wait(): Promise<never> {
            releaseAbort();
            // Ignores cancellation entirely and rejects long after disposal.
            return new Promise((_resolve, reject) => {
              setTimeout(() => {
                lateOutcome = "rejected";
                reject(new Error("late non-cooperative failure"));
              }, 2_000);
            });
          }
        }
      }
    }).then(
      () => ({ outcome: "completed" as const }),
      (cause: unknown) => reportFailure(cause)
    );
    const settledAt = Date.now();
    releaseAbort();
    await aborted;
    const settledMs = abortedAt === 0 ? -1 : settledAt - abortedAt;
    // Let the late rejection fire inside this invocation; containment means
    // the scenario still returns normally afterwards.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    return { ...report, settledMs, lateOutcome };
  },

  /**
   * 7. Twenty identical trivial runs for the timing baseline. Measured
   * inside the parent Worker around `run()`: trivial runs are I/O-bound
   * (loading and evaluating are RPC events, which advance the otherwise
   * frozen clock), and client-side timing would pollute the baseline with
   * the test machine's internet round trip.
   */
  async timing(env) {
    const durationsMs: number[] = [];
    for (let index = 0; index < 20; index++) {
      const started = Date.now();
      const result = await run<number>({
        loader: env.LOADER,
        source: "return 1 + 1;"
      });
      if (result.value !== 2) {
        return { outcome: "unexpected-value", value: result.value };
      }
      durationsMs.push(Date.now() - started);
    }
    return { outcome: "completed", durationsMs };
  }
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const name = url.pathname.startsWith("/scenario/")
      ? url.pathname.slice("/scenario/".length)
      : "";
    const scenario = scenarios[name];
    if (request.method !== "POST" || scenario === undefined) {
      return new Response("not found", { status: 404 });
    }
    try {
      return Response.json(await scenario(env));
    } catch (cause: unknown) {
      return Response.json(
        { outcome: "scenario-crash", message: String(cause) },
        { status: 500 }
      );
    }
  }
} satisfies ExportedHandler<Env>;
