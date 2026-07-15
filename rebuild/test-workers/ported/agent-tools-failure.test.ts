/**
 * Ported from ORIGINAL Agents:
 * - packages/agents/src/tests/agent-tools-failure.test.ts
 * - last original change: 0f47d61c
 * - port date: 2026-07-15
 * Modifications:
 * - Re-pointed original `agentTool` usage to the rebuild's compat-exported
 *   `agentTool` and real `createAgentToolRunService`.
 * - Re-authored the original `agentContext.run(...)` stub as a minimal real
 *   delegation service harness with a scripted child registry.
 * - Kept original failure-envelope assertions intentionally red against the
 *   rebuild's current `{ error: { name, message } }` shape and fresh run ids
 *   (`missing-feature ISSUE-035`).
 */
// @ts-nocheck
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agentTool, createAgentToolRunService } from "./compat.js";

type Relay = {
  onStart(info: { requestId: string }): void;
  onEvent(json: unknown): void;
  onDone(): void;
  onError(err: unknown): void;
  onInterrupted?(): void;
};

type Script = (relay: Relay, prompt: string) => void | Promise<void>;

class MemoryStore {
  map = new Map<string, unknown>();

  get(key: string): unknown {
    return this.map.get(key);
  }

  put(key: string, value: unknown): void {
    this.map.set(key, structuredClone(value));
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  list(options?: { prefix?: string; limit?: number }): Map<string, unknown> {
    const prefix = options?.prefix ?? "";
    const out = new Map<string, unknown>();
    for (const key of [...this.map.keys()].sort()) {
      if (!key.startsWith(prefix)) continue;
      out.set(key, structuredClone(this.map.get(key)));
      if (options?.limit !== undefined && out.size >= options.limit) break;
    }
    return out;
  }

  deleteAll(options?: { prefix?: string }): number {
    const prefix = options?.prefix ?? "";
    let count = 0;
    for (const key of [...this.map.keys()]) {
      if (key.startsWith(prefix) && this.map.delete(key)) count++;
    }
    return count;
  }
}

function harness(script: Script) {
  let seenPrompt: string | undefined;
  let seenChildName: string | undefined;
  const store = new MemoryStore();
  const clock = { now: () => Date.now() };
  const ids = { newId: (prefix: string) => `${prefix}-generated` };
  const bus = { emit() {}, subscribe: () => () => {} };
  const registry = {
    get(_className: string, name: string) {
      seenChildName = name;
      return {
        className: "Child",
        name,
        async call(method: string, args: unknown[]) {
          if (method === "chat") {
            const [prompt, relay] = args as [string, Relay];
            seenPrompt = prompt;
            await script(relay, prompt);
            return undefined;
          }
          if (method === "cancelChat") return undefined;
          if (method === "inspectRun") return null;
          throw new Error(`Unexpected child method ${method}`);
        },
        abort() {}
      };
    },
    has: () => false,
    list: () => [],
    delete: async () => {}
  };
  const runs = createAgentToolRunService({
    store,
    registry,
    clock,
    ids,
    bus
  });
  const subAgent = agentTool(
    "Child",
    {
      description: "Run a sub-agent",
      inputSchema: z.object({ task: z.string() })
    },
    { runs }
  );
  const controller = new AbortController();
  const execute = subAgent.execute as (
    input: unknown,
    ctx: {
      toolCallId: string;
      requestId: string;
      messages: unknown[];
      signal: AbortSignal;
    }
  ) => Promise<unknown>;
  const run = () =>
    execute(
      { task: "do a thing" },
      {
        toolCallId: "call-1",
        requestId: "req-1",
        messages: [],
        signal: controller.signal
      }
    );
  return {
    run,
    controller,
    captured: () => ({
      runId: seenChildName,
      parentToolCallId: undefined,
      prompt: seenPrompt
    })
  };
}

describe("agentTool failure envelope (ported)", () => {
  it("marks an interrupted run as retryable and surfaces its reason", async () => {
    // missing-feature ISSUE-035: rebuild RunStatus has no `interrupted`, so the
    // closest real path is an error terminal with the current `{ error }` shape.
    const h = harness((relay) => relay.onError(new Error("child reset by deploy")));
    await expect(h.run()).resolves.toMatchObject({
      ok: false,
      status: "interrupted",
      retryable: true,
      error: "child reset by deploy"
    });
  });

  it("marks an explicit cancellation as aborted and non-retryable", async () => {
    // missing-feature ISSUE-035: rebuild returns `{ error: { name:
    // "AbortedError", message } }`, not the original structured envelope.
    const h = harness(() => new Promise(() => {}));
    const out = h.run();
    queueMicrotask(() => h.controller.abort());
    await expect(out).resolves.toMatchObject({
      ok: false,
      status: "aborted",
      retryable: false
    });
  });

  it("marks a genuine error as non-retryable", async () => {
    // missing-feature ISSUE-035: current failure envelope omits ok/status/retryable.
    const h = harness((relay) => relay.onError(new Error("boom")));
    await expect(h.run()).resolves.toMatchObject({
      ok: false,
      status: "error",
      retryable: false,
      error: "boom"
    });
  });

  it("returns the summary string on completion (no failure envelope)", async () => {
    // plain pass: completed runs return summary/output directly.
    const h = harness((relay) => {
      relay.onEvent({ text: "all done" });
      relay.onDone();
    });
    await expect(h.run()).resolves.toBe("all done");
  });

  it("derives a stable runId from the tool call id so recovery re-attaches instead of re-running (#1630)", async () => {
    // missing-feature ISSUE-035: startRun always mints a fresh run id and
    // agentTool does not pass parentToolCallId/toolCallId-derived runId.
    const h = harness((relay) => relay.onDone());
    await h.run();
    expect(h.captured().runId).toBe("agent-tool:call-1");
    expect(h.captured().parentToolCallId).toBe("call-1");
  });
});
