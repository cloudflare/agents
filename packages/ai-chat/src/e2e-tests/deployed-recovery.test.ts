/**
 * DEPLOYED e2e: chat recovery on real Cloudflare Workers (not local workerd).
 *
 * Unlike the SIGKILL-based local suites, this proves recovery survives the
 * production trigger it actually exists for: a Worker is REDEPLOYED while a chat
 * turn is mid-stream, which evicts the live Durable Object. On next access the
 * DO cold-starts, restart detection fires, and the persisted recovery incident
 * drives the interrupted turn to completion.
 *
 * This suite creates REAL, billable resources, so it is double-gated:
 *  1. It is only wired into the dedicated `test:e2e:deployed` script (never the
 *     default `test` / `test:e2e`).
 *  2. The body is skipped unless `RUN_DEPLOYED_E2E=1`, so even running that
 *     script is a no-op without an explicit opt-in.
 *
 * It deploys `wrangler.deployed.jsonc` (a uniquely-named Worker), drives the
 * scenarios against the live `*.workers.dev` URL, and ALWAYS deletes the Worker
 * in teardown. Requires an authenticated `wrangler` (run `wrangler whoami`). With
 * multiple accessible accounts, pin the target with `CLOUDFLARE_ACCOUNT_ID` to
 * avoid an `Authentication error [code: 10000]` from the wrong account.
 *
 * Scenarios:
 *  1. A mid-turn redeploy evicts the live DO -> recovery fires on cold start.
 *  2. A normally-completed turn is NOT spuriously recovered by reconnect / idle
 *     churn, and the agent keeps serving fresh turns (the false-positive guard).
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pollUntil, rpcCall, sendChatMessage } from "./harness";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(__dirname, "wrangler.deployed.jsonc");
const AGENT_NAME = "chat-recovery-deployed-e2e";
const RUN = process.env.RUN_DEPLOYED_E2E === "1";

/** Build an agent WebSocket (wss) URL from the deployed https base URL. */
function wsUrlFor(baseUrl: string, agentPath: string, name: string): string {
  return `${baseUrl.replace(/^http/, "ws")}/agents/${agentPath}/${name}`;
}

type RecoveryStatus = {
  recoveryCount: number;
  contexts: Array<{ streamId: string; requestId: string; partialText: string }>;
  messageCount: number;
  assistantMessages: number;
};

/**
 * Deploy (or redeploy) the test Worker and return its live URL. Merges stderr
 * into stdout because wrangler prints the deployed URL across both streams
 * depending on version.
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

/**
 * Deploy with a small retry. Back-to-back deploys of the same Worker
 * occasionally hit a transient deploy-API error; a couple of spaced retries
 * absorb that without restarting the whole (slow) deploy -> evict -> recover
 * cycle via vitest's outer retry.
 */
function deploy(attempts = 3): string {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return deployOnce();
    } catch (error) {
      lastError = error;
      console.warn(`[deployed-e2e] deploy attempt ${i + 1} failed; retrying`);
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
    // Never let a teardown failure mask the test result, but make the leak loud
    // so the Worker can be removed manually (`wrangler delete chat-recovery-e2e-deployed`).
    console.warn(
      "[deployed-e2e] failed to delete the test Worker — delete it manually:",
      error
    );
  }
}

/** Derive the agent WebSocket URL (wss) from the deployed https base URL. */
function agentWsUrl(baseUrl: string): string {
  // ChatHangingRecoveryAgent: its turn hangs forever, so it is guaranteed to be
  // mid-flight when the (slow) redeploy evicts the DO.
  return wsUrlFor(baseUrl, "chat-hanging-recovery-agent", AGENT_NAME);
}

async function waitForLive(baseUrl: string): Promise<void> {
  await pollUntil(
    "deployed route live",
    async () => {
      const res = await fetch(baseUrl);
      await res.body?.cancel();
      return res.status;
    },
    (status) => status > 0,
    { attempts: 30, delayMs: 2000 }
  );
}

describe.skipIf(!RUN)("deployed chat recovery e2e", () => {
  let baseUrl = "";

  beforeAll(() => {
    baseUrl = deploy();
  }, 200_000);

  afterAll(() => {
    destroy();
  }, 130_000);

  it("fires recovery after a mid-turn redeploy evicts the DO on real Workers", async () => {
    await waitForLive(baseUrl);
    const wsUrl = agentWsUrl(baseUrl);

    // Start a turn that hangs forever, then confirm its fiber is persisted so the
    // redeploy is guaranteed to interrupt a live, in-flight turn. A freshly
    // created workers.dev route can drop the first WS handshakes during cold
    // start/propagation, so resilience here: retry send+check until a fiber row
    // appears, tolerating transient socket errors.
    await pollUntil(
      "deployed fiber persisted",
      async () => {
        try {
          await sendChatMessage(wsUrl, "Tell me something interesting", 2000);
        } catch {
          // Transient WS error during cold start; the next poll retries.
        }
        return (await (
          rpcCall(wsUrl, "hasFiberRows") as Promise<boolean>
        ).catch(() => false)) as boolean;
      },
      (has) => has === true,
      { attempts: 20, delayMs: 2000 }
    );

    // Force a real DO eviction the way production does: redeploy the Worker
    // mid-turn. The in-flight isolate is discarded; the persisted fiber + alarm
    // survive in DO storage and drive recovery on the next cold start.
    deploy();
    await waitForLive(baseUrl);

    // Poll the agent. Each poll opens a fresh socket, which wakes the cold DO and
    // runs restart detection; the orphaned fiber then opens a recovery incident
    // and fires onChatRecovery. This is the signal the local SIGKILL suite can't
    // give us: recovery actually triggers on Cloudflare's real edge.
    const status = (await pollUntil(
      "deployed recovery",
      () => rpcCall(wsUrl, "getRecoveryStatus") as Promise<RecoveryStatus>,
      (s) => s.recoveryCount > 0,
      { attempts: 45, delayMs: 2000 }
    )) as RecoveryStatus;

    expect(status.recoveryCount).toBeGreaterThanOrEqual(1);
    expect(status.contexts.length).toBeGreaterThanOrEqual(1);
    expect(status.contexts[0].requestId.length).toBeGreaterThan(0);

    // The durable "recovering…" flag (#1620) is a secondary, timing-sensitive
    // signal (and is asserted deterministically by the local
    // chat-recovering-status suite), so here it is only logged, not asserted —
    // the edge-recovery proof is the recovery incident above.
    const recoveringFlag = await rpcCall(wsUrl, "getRecoveringFlag");
    console.log(
      "[deployed-e2e] recovering flag after recovery:",
      recoveringFlag
    );
  }, 600_000);

  // The flip side of the recovery proof: a turn that COMPLETED normally must NOT
  // be spuriously "recovered" by ordinary client reconnect / idle-hibernation
  // churn on the real edge. Each fresh socket wakes the DO and runs restart
  // detection — but with no orphaned fiber there must be no incident, the
  // persisted assistant message must stay intact, and the agent must keep
  // serving fresh turns. This is the deterministic counterpart to the eviction
  // test above (it uses the finite-streaming `ChatRecoveryTestAgent`, no
  // redeploy), guarding against a false-positive recovery on the live runtime.
  it("does NOT fire recovery on reconnect after a turn completes, and keeps serving", async () => {
    await waitForLive(baseUrl);
    const name = `chat-recovery-noincident-e2e-${Date.now()}`;
    const wsUrl = wsUrlFor(baseUrl, "chat-recovery-test-agent", name);

    // Start the first (finite ~12s) turn. A freshly-propagated route can drop the
    // first WS handshakes, so retry the send until exactly one turn registers.
    await pollUntil(
      "first turn started",
      async () => {
        const invocations = (await (
          rpcCall(wsUrl, "getChatMessageInvocations") as Promise<number>
        ).catch(() => 0)) as number;
        if (invocations === 0) {
          await sendChatMessage(wsUrl, "First message", 1500).catch(() => {
            // Transient cold-start WS error; the next poll retries the send.
          });
        }
        return invocations;
      },
      (invocations) => invocations >= 1,
      { attempts: 20, delayMs: 2000 }
    );

    // The turn runs durably in the DO regardless of the (now-closed) client
    // socket. Wait for it to finish: an assistant message is persisted and the
    // in-flight fiber row is cleaned up on normal completion.
    const completed = (await pollUntil(
      "first turn completed",
      () => rpcCall(wsUrl, "getRecoveryStatus") as Promise<RecoveryStatus>,
      (s) => s.assistantMessages >= 1,
      { attempts: 45, delayMs: 2000 }
    )) as RecoveryStatus;
    expect(completed.recoveryCount).toBe(0);
    const fiberAfterDone = await rpcCall(wsUrl, "hasFiberRows");
    expect(fiberAfterDone).toBe(false);
    const textAfterDone = (await rpcCall(wsUrl, "getAssistantText")) as string;
    expect(textAfterDone.length).toBeGreaterThan(0);

    // Reconnect churn: open and close several fresh sockets, each of which wakes
    // the DO and runs restart detection. None must open a recovery incident.
    for (let i = 0; i < 4; i++) {
      await rpcCall(wsUrl, "hasFiberRows").catch(() => false);
    }
    const afterReconnects = (await rpcCall(
      wsUrl,
      "getRecoveryStatus"
    )) as RecoveryStatus;
    expect(afterReconnects.recoveryCount).toBe(0);
    expect(afterReconnects.assistantMessages).toBe(completed.assistantMessages);
    const textAfterReconnects = (await rpcCall(
      wsUrl,
      "getAssistantText"
    )) as string;
    expect(textAfterReconnects).toBe(textAfterDone);

    // The agent still serves new work after the reconnect churn: a second turn
    // runs and completes, the invocation count advances by exactly one (no
    // recovery re-run snuck in), and recovery never fired.
    const invBeforeSecond = (await rpcCall(
      wsUrl,
      "getChatMessageInvocations"
    )) as number;
    await pollUntil(
      "second turn started",
      async () => {
        const invocations = (await (
          rpcCall(wsUrl, "getChatMessageInvocations") as Promise<number>
        ).catch(() => invBeforeSecond)) as number;
        if (invocations === invBeforeSecond) {
          await sendChatMessage(wsUrl, "Second message", 1500).catch(() => {});
        }
        return invocations;
      },
      (invocations) => invocations > invBeforeSecond,
      { attempts: 20, delayMs: 2000 }
    );
    const finalStatus = (await pollUntil(
      "second turn completed",
      () => rpcCall(wsUrl, "getRecoveryStatus") as Promise<RecoveryStatus>,
      (s) => s.assistantMessages >= 2,
      { attempts: 45, delayMs: 2000 }
    )) as RecoveryStatus;
    expect(finalStatus.recoveryCount).toBe(0);

    const finalInvocations = (await rpcCall(
      wsUrl,
      "getChatMessageInvocations"
    )) as number;
    // Exactly two user turns ran; a recovery continuation would have bumped this
    // beyond the number of submitted turns.
    expect(finalInvocations).toBe(2);
  }, 600_000);
});
