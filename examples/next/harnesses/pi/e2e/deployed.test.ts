/**
 * DEPLOYED e2e: the pi harness on real Cloudflare Workers, broken mid-turn.
 *
 * Local workerd enforces no memory or CPU limit and no alarm wall time, so
 * these only mean anything on the real edge. Each scenario runs one turn on
 * its own Durable Object and checks that the turn recovered and the model
 * then finished a secondary task (one more tool call and a sum):
 *
 *  - oom: a tool fills memory until the isolate exceeds 128 MB.
 *  - burn_cpu: a tool hashes an endless `fetch()` body until the invocation
 *    exceeds its 30 s CPU limit.
 *  - wall-time: the model alternates `sleep` (60 s) and `current_time` for
 *    30 minutes, twice the 15-minute wall-time limit of the alarm invocation
 *    the harness waits in.
 *
 * The suite never wakes the agent it tests. Each agent reports its outcome
 * to a separate object (see `src/e2e/worker.ts`), so the recovery is the
 * harness's own wake alarm, not a client reconnecting.
 *
 * It creates REAL, billable resources (a Worker, Durable Objects, Workers AI
 * calls), so it is double-gated: only the `test:e2e:deployed` script runs it,
 * and it is skipped unless `RUN_DEPLOYED_E2E=1`. It deploys
 * `src/e2e/wrangler.jsonc` under a unique name and always deletes it.
 * Requires an authenticated `wrangler`; with several accounts, set
 * `CLOUDFLARE_ACCOUNT_ID`. `PI_E2E_SCENARIOS=oom,burn_cpu` runs a subset
 * (the wall-time scenario alone takes over 30 minutes).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  crashPrompt,
  longRunningPrompt,
  secondaryTask,
  type CrashTool
} from "agents/tools/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PiMessage, PiOperationResult } from "../src/harness/types";
import { TOKEN_HEADER, type ChaosStatus } from "../src/e2e/protocol";

const RUN = process.env.RUN_DEPLOYED_E2E === "1";
const SCENARIOS = new Set(
  (process.env.PI_E2E_SCENARIOS ?? "oom,burn_cpu,wall-time")
    .split(",")
    .map((scenario) => scenario.trim())
);

const EXAMPLE_DIR = path.resolve(import.meta.dirname, "..");
const CONFIG = path.join(EXAMPLE_DIR, "src/e2e/wrangler.jsonc");
const WORKER_NAME = `pi-harness-e2e-${Date.now()}`;
const TOKEN = crypto.randomUUID();

const MINUTE = 60_000;
const POLL_MS = 10_000;

function wrangler(args: string[], timeoutMs: number): string {
  const result = spawnSync("npx", ["wrangler", ...args], {
    cwd: EXAMPLE_DIR,
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, CLOUDFLARE_INCLUDE_PROCESS_ENV: "true" }
  });
  // wrangler prints across both streams depending on version.
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  console.log(output);
  if (result.status !== 0) {
    throw new Error(`wrangler ${args[0]} failed (${result.status})`);
  }
  return output;
}

function deploy(): string {
  let lastError: unknown;
  // Back-to-back deploys occasionally hit a transient API error.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const output = wrangler(
        [
          "deploy",
          "--config",
          CONFIG,
          "--name",
          WORKER_NAME,
          "--var",
          `E2E_TOKEN:${TOKEN}`
        ],
        180_000
      );
      const url = /https:\/\/[^\s]+\.workers\.dev/.exec(output)?.[0];
      if (url === undefined) {
        throw new Error("Could not find the workers.dev URL in the output");
      }
      return url;
    } catch (error) {
      lastError = error;
      console.warn(`[pi-e2e] deploy attempt ${attempt} failed`, error);
    }
  }
  throw lastError;
}

function destroy(): void {
  try {
    wrangler(
      ["delete", "--config", CONFIG, "--name", WORKER_NAME, "--force"],
      120_000
    );
  } catch (error) {
    // Never mask the test result, but make the leak loud.
    console.warn(
      `[pi-e2e] failed to delete ${WORKER_NAME}; delete it manually`,
      error
    );
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One tool call from the transcript, with its result when there is one. */
type ToolCall = {
  readonly name: string;
  readonly error: boolean | undefined;
  readonly text: string;
};

/** Tool calls in transcript order, each joined with its result. */
function toolCalls(messages: readonly PiMessage[]): ToolCall[] {
  const results = new Map<string, { error: boolean; text: string }>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool-result") continue;
      results.set(part.id, {
        error: part.error,
        text: part.content
          .map((c) => (c.type === "text" ? c.text : ""))
          .join("")
      });
    }
  }
  const calls: ToolCall[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool-call") continue;
      const result = results.get(part.id);
      calls.push({
        name: part.name,
        error: result?.error,
        text: result?.text ?? ""
      });
    }
  }
  return calls;
}

function isSettled(
  operation: ChaosStatus["operation"]
): operation is PiOperationResult {
  return operation.status !== "pending";
}

describe.skipIf(!RUN)("pi harness on deployed Workers", () => {
  let baseUrl = "";

  async function request(pathname: string, init: RequestInit = {}) {
    return fetch(`${baseUrl}${pathname}`, {
      ...init,
      headers: { [TOKEN_HEADER]: TOKEN, ...init.headers }
    });
  }

  async function submit(agent: string, prompt: string): Promise<void> {
    // A fresh workers.dev route can drop the first requests. pi dedupes by
    // operation id, so a retry of a submit that did land is harmless.
    const operationId = crypto.randomUUID();
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await request(`/e2e/${agent}/submit`, {
          method: "POST",
          body: JSON.stringify({ prompt, operationId })
        });
        if (!response.ok) throw new Error(`submit: ${response.status}`);
        await response.body?.cancel();
        return;
      } catch (error) {
        if (attempt >= 5) throw error;
        await sleep(2000);
      }
    }
  }

  /**
   * Poll the agent's reported result until it settles. The result lives in
   * a separate object, so polling never wakes the agent: recovering from a
   * crash, and continuing past an alarm's wall-time limit, is all the
   * harness's own doing. On timeout, read the agent itself for diagnostics.
   */
  async function settle(
    agent: string,
    timeoutMs: number
  ): Promise<ChaosStatus & { operation: PiOperationResult }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      try {
        const response = await request(`/e2e/${agent}/result`);
        if (!response.ok) throw new Error(`result: ${response.status}`);
        const result = (await response.json()) as ChaosStatus | null;
        if (result !== null && isSettled(result.operation)) {
          console.log(
            `[pi-e2e] ${agent}: instances=${result.instances} tools=${toolCalls(
              result.messages
            )
              .map((call) => `${call.name}${call.error ? "!" : ""}`)
              .join(",")}`
          );
          return { ...result, operation: result.operation };
        }
      } catch (error) {
        console.warn(`[pi-e2e] ${agent}: poll failed`, error);
      }
    }
    const status = await request(`/e2e/${agent}/status`)
      .then((response) => response.text())
      .catch((error: unknown) => String(error));
    throw new Error(
      `${agent} reported no result in ${timeoutMs / MINUTE} minutes. Its status now: ${status}`
    );
  }

  beforeAll(async () => {
    baseUrl = deploy();
    for (let attempt = 1; attempt <= 30; attempt++) {
      const response = await request("/health").catch(() => undefined);
      if (response?.ok) return;
      await sleep(2000);
    }
    throw new Error(`${baseUrl} never became healthy`);
  }, 5 * MINUTE);

  afterAll(() => {
    destroy();
  }, 3 * MINUTE);

  const crashTools: readonly CrashTool[] = ["oom", "burn_cpu"];
  for (const tool of crashTools) {
    it.skipIf(!SCENARIOS.has(tool))(
      `recovers a turn that ${tool} kills mid-turn, then finishes the secondary task`,
      async () => {
        const agent = `${tool.replace("_", "-")}-${Date.now()}`;
        await submit(agent, crashPrompt(tool));

        const status = await settle(agent, 15 * MINUTE);

        expect(status.operation.status).toBe("done");
        const calls = toolCalls(status.messages);
        const crash = calls.findIndex((call) => call.name === tool);
        // Mid-turn: a tool ran before the crash.
        expect(calls.slice(0, crash).map((call) => call.name)).toContain(
          "current_time"
        );
        // The crash interrupted the call, and the object restarted.
        expect(calls[crash]).toMatchObject({ error: true });
        expect(calls[crash]?.text).toMatch(/interrupted/i);
        expect(status.instances).toBeGreaterThanOrEqual(2);
        // After recovery, tools still run and the model finishes the task.
        expect(
          calls
            .slice(crash + 1)
            .some((call) => call.name === "current_time" && !call.error)
        ).toBe(true);
        expect(status.operation.text).toContain(secondaryTask.answer);
      },
      20 * MINUTE
    );
  }

  it.skipIf(!SCENARIOS.has("wall-time"))(
    "keeps one turn running for 30 minutes, past the 15-minute alarm wall-time limit, then finishes the secondary task",
    async () => {
      const agent = `wall-time-${Date.now()}`;
      await submit(agent, longRunningPrompt());

      const status = await settle(agent, 50 * MINUTE);

      expect(status.operation.status).toBe("done");
      const calls = toolCalls(status.messages);
      expect(
        calls.filter((call) => call.name === "sleep" && !call.error).length
      ).toBeGreaterThanOrEqual(25);
      const times = calls
        .filter((call) => call.name === "current_time" && !call.error)
        .map((call) => Date.parse(call.text));
      const first = times[0] ?? Number.NaN;
      const last = times.at(-1) ?? Number.NaN;
      expect(last - first).toBeGreaterThanOrEqual(30 * MINUTE);
      expect(status.operation.text).toContain(secondaryTask.answer);
    },
    55 * MINUTE
  );
});
