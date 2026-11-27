/**
 * Chat recovery as an app sees it: a model stream that stalls, the app's
 * `chatRecovery` and `onChatRecovery`, and what the conversation holds once
 * the agent is stable. Public API only, so it runs on Think and on the
 * harness-backed Think alike.
 */
import { env, exports } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it, vi } from "vitest";

async function freshAgent(name: string) {
  return getAgentByName(env.ThinkTestAgent, `${name}-${crypto.randomUUID()}`);
}

describe("chat recovery, through public behaviour", () => {
  it("continues a stalled turn and calls onChatRecovery with its partial", async () => {
    const agent = await freshAgent("recover-stall");
    const result = await agent.stallRecoveryForTest({
      afterParts: 2,
      stalledCalls: 1,
      timeoutMs: 50
    });

    expect(result.stable).toBe(true);
    expect(result.recoveryCalls.length).toBeGreaterThanOrEqual(1);
    expect(result.recoveryCalls[0]).toMatchObject({
      attempt: 1,
      recoveryKind: "continue",
      partialText: "Hello from the assistant!"
    });
    expect(result.roles).toEqual(["user", "assistant"]);
  });

  it("gives up a stalled turn when onChatRecovery declines to continue", async () => {
    const agent = await freshAgent("recover-decline");
    const result = await agent.stallRecoveryForTest({
      afterParts: 2,
      stalledCalls: 1,
      timeoutMs: 50,
      recovery: { continue: false }
    });

    expect(result.first.error).toBeTruthy();
    expect(result.recoveryCalls).toHaveLength(1);
    expect(result.stable).toBe(true);
    // Nothing continues it: the model is not called again.
    expect(result.modelCalls).toBe(1);
  });

  it("asks onChatRecovery no more often than chatRecovery's attempts allow", async () => {
    const agent = await freshAgent("recover-spent");
    const result = await agent.stallRecoveryForTest({
      afterParts: 2,
      stalledCalls: 5,
      timeoutMs: 50,
      chatRecovery: { maxAttempts: 1 }
    });

    expect(result.stable).toBe(true);
    expect(result.recoveryCalls).toHaveLength(1);
    // The interrupted reply's text is kept.
    expect(result.lastAssistantText).toContain("Hello from the assistant!");
  });

  it("ends a stalled turn with an error when onChatRecovery throws", async () => {
    const agent = await freshAgent("recover-throw");
    const result = await agent.stallRecoveryForTest({
      afterParts: 2,
      stalledCalls: 1,
      timeoutMs: 50,
      recovery: "throw"
    });

    expect(result.first.error).toBeTruthy();
    expect(result.recoveryCalls).toHaveLength(1);
    expect(result.stable).toBe(true);
    expect(result.modelCalls).toBe(1);
  });

  it("recovers a stall when only beforeTurn sets the stall timeout", async () => {
    const agent = await freshAgent("recover-per-turn");
    const result = await agent.stallRecoveryForTest({
      afterParts: 2,
      stalledCalls: 1,
      timeoutMs: 50,
      perTurn: true
    });

    expect(result.stable).toBe(true);
    expect(result.recoveryCalls[0]).toMatchObject({ attempt: 1 });
    expect(result.roles).toEqual(["user", "assistant"]);
  });

  it("gives onChatRecovery the time the turn was asked for, not the time of the stall", async () => {
    const agent = await freshAgent("recover-created-at");
    const result = await agent.stallRecoveryForTest({
      afterParts: 2,
      stalledCalls: 1,
      timeoutMs: 1500
    });

    const createdAt = result.recoveryCalls[0]?.createdAt ?? 0;
    expect(createdAt).toBeGreaterThanOrEqual(result.askedAt - 50);
    // The stall fires 1500 ms after the reply starts; the turn started
    // well before that.
    expect(createdAt).toBeLessThan(result.askedAt + 1000);
  });

  // Successors of onChatRecovery's context tests (think-session, "Think —
  // onChatRecovery"): what the hook is told about the turn it recovers.
  describe("onChatRecovery's context", () => {
    it("tells onChatRecovery the interrupted turn's partial text and when it was interrupted", async () => {
      const agent = await freshAgent("recover-context");
      const result = await agent.stallRecoveryForTest({
        afterParts: 2,
        stalledCalls: 1,
        timeoutMs: 50
      });

      const [first] = result.recoveryCalls;
      expect(first?.partialText).toBe("Hello from the assistant!");
      expect(first?.streamId).toEqual(expect.any(String));
      expect(first?.streamId).not.toBe("");
      expect(first?.createdAt).toBeGreaterThanOrEqual(result.startedAt);
      expect(first?.createdAt).toBeLessThanOrEqual(Date.now());
    });

    it("hands onChatRecovery the data the turn stashed", async () => {
      const agent = await freshAgent("recover-stash");
      const result = await agent.stallRecoveryForTest({
        afterParts: 2,
        stalledCalls: 1,
        timeoutMs: 50,
        stash: "the turn's own notes"
      });

      expect(result.recoveryCalls[0]?.recoveryData).toBe(
        "the turn's own notes"
      );
    });

    it("tells onChatRecovery of a turn interrupted before it streamed anything, with no partial", async () => {
      const agent = await freshAgent("recover-pre-stream");
      const result = await agent.stallRecoveryForTest({
        afterParts: 0,
        stalledCalls: 1,
        timeoutMs: 50
      });

      expect(result.recoveryCalls.length).toBeGreaterThanOrEqual(1);
      expect(result.recoveryCalls[0]?.partialText).toBe("");
    });

    it("names the interrupted turn as the root of its recovery", async () => {
      const agent = await freshAgent("recover-root");
      const result = await agent.stallRecoveryForTest({
        afterParts: 2,
        stalledCalls: 1,
        timeoutMs: 50
      });

      const [first] = result.recoveryCalls;
      expect(first?.recoveryRootRequestId).toEqual(expect.any(String));
      expect(first?.recoveryRootRequestId).toBe(first?.requestId);
    });
  });

  // The same context after a real reset of the isolate mid-turn, as an
  // eviction or a deploy leaves a turn: the recovery runs on the next start.
  describe("onChatRecovery's context after a reset", () => {
    async function resetDuringTurn(name: string, chunksBeforeReset: number) {
      const room = `${name}-${crypto.randomUUID()}`;
      const agent = () => getAgentByName(env.ThinkTestAgent, room);
      const startedAt = Date.now();
      if (chunksBeforeReset === 0) {
        // No stream at all: the model call waits on the provider.
        await (await agent()).hangModelAtConnectForTest();
      } else {
        await (
          await agent()
        ).useSlowModelForTest(
          ["one ", "two ", "three ", "four ", "five ", "six "],
          150
        );
      }
      const res = await exports.default.fetch(
        `http://example.com/agents/think-test-agent/${room}`,
        { headers: { Upgrade: "websocket" } }
      );
      const ws = res.webSocket;
      if (!ws) throw new Error("no socket");
      ws.accept();
      const requestId = crypto.randomUUID();
      let chunks = 0;
      ws.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as {
          type?: string;
          body?: string;
          done?: boolean;
        };
        if (frame.type !== "cf_agent_use_chat_response" || frame.done) return;
        if (frame.body?.includes("text-delta")) chunks++;
      });
      ws.send(
        JSON.stringify({
          type: "cf_agent_use_chat_request",
          id: requestId,
          init: {
            method: "POST",
            body: JSON.stringify({
              messages: [
                {
                  id: crypto.randomUUID(),
                  role: "user",
                  parts: [{ type: "text", text: "reset me" }]
                }
              ]
            })
          }
        })
      );
      // Mid-reply: after some text. Before the first chunk: while the model
      // call waits on the provider, before any stream.
      await vi.waitFor(
        async () => {
          expect(
            chunksBeforeReset === 0
              ? await (await agent()).modelConnectingForTest()
              : chunks >= chunksBeforeReset
          ).toBe(true);
        },
        { timeout: 10_000, interval: 10 }
      );
      const resetAt = Date.now();
      await (await agent()).resetIsolateForTest().catch(() => undefined);
      ws.close();
      // The next start recovers the turn and asks onChatRecovery.
      let calls: Array<{
        partialText: string;
        streamId: string;
        createdAt: number;
        recoveryRootRequestId: string;
      }> = [];
      await vi.waitFor(
        async () => {
          calls = [...(await (await agent()).recoveryCallsForTest())];
          expect(calls.length).toBeGreaterThanOrEqual(1);
        },
        { timeout: 15_000, interval: 50 }
      );
      return { requestId, calls, startedAt, resetAt };
    }

    it("tells onChatRecovery the partial a reset cut off mid-reply", async () => {
      const { requestId, calls } = await resetDuringTurn("reset-mid", 2);
      const [first] = calls;
      // What the reset left of the reply: text the tab had seen, not empty.
      expect(first?.partialText).toMatch(/^one /);
      expect(first?.streamId).toEqual(expect.any(String));
      expect(first?.streamId).not.toBe("");
      expect(first?.createdAt).toEqual(expect.any(Number));
      expect(first?.recoveryRootRequestId).toBe(requestId);
    }, 30_000);

    it("dates a reset-interrupted turn by when it started, not by when it was recovered", async () => {
      const { calls, startedAt, resetAt } = await resetDuringTurn(
        "reset-created-at",
        2
      );
      // `createdAt` is the interrupted turn's start: before the reset that
      // cut it off, so before the recovery that runs after it.
      expect(calls[0]?.createdAt).toBeGreaterThanOrEqual(startedAt);
      expect(calls[0]?.createdAt).toBeLessThanOrEqual(resetAt);
    }, 30_000);

    it("tells onChatRecovery of a turn a reset cut off before its first chunk, with no partial", async () => {
      const { requestId, calls } = await resetDuringTurn("reset-pre", 0);
      const [first] = calls;
      expect(first?.partialText).toBe("");
      expect(first?.recoveryRootRequestId).toBe(requestId);
    }, 30_000);
  });
  it("gives every recovery hook one incident id and stream id", async () => {
    const agent = await freshAgent("recover-one-incident");
    await agent.armGiveUpForTest(2);

    let ids = await agent.recoveryIdsForTest();
    const deadline = Date.now() + 20_000;
    while (
      !ids.hooks.some((entry) => entry.hook === "onExhausted") &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      ids = await agent.recoveryIdsForTest();
    }

    const incident = ids.onChatRecovery[0];
    expect(incident).toBeDefined();
    const hooks = ids.hooks.map((entry) => entry.hook);
    expect(hooks).toContain("onExhausted");
    expect(hooks).toContain("shouldKeepRecovering");
    // One incident across the hooks. (Stream ids are not compared: Think
    // opens a new stream for each attempt, the harness keeps one.)
    for (const entry of ids.hooks) {
      expect(entry.incidentId).toBe(incident.incidentId);
    }
  }, 30_000);

  // Successors of the budget and seal tests (think-session, "Think —
  // onChatRecovery"): when recovery gives up, and what onExhausted is told.
  describe("the recovery budget", () => {
    async function recoverUntil(
      name: string,
      options: {
        afterParts: number;
        stalledCalls: number;
        maxAttempts: number;
        keepRecovering?: boolean;
      },
      done: (progress: {
        recoveryCalls: unknown[];
        exhausted: unknown[];
        lastAssistantText: string;
      }) => boolean
    ) {
      const agent = await freshAgent(name);
      await agent.armLastingStallForTest({ ...options, timeoutMs: 50 });
      await agent.testChat("stall, then recover");
      let progress = await agent.recoveryProgressForTest();
      await vi.waitFor(
        async () => {
          progress = await agent.recoveryProgressForTest();
          expect(done(progress)).toBe(true);
        },
        { timeout: 20_000, interval: 50 }
      );
      return progress;
    }

    it("gives up through onExhausted with max_attempts_exceeded once the attempts are spent", async () => {
      const progress = await recoverUntil(
        "budget-spent",
        { afterParts: 0, stalledCalls: 10, maxAttempts: 2 },
        (p) => p.exhausted.length > 0
      );

      expect(progress.exhausted).toHaveLength(1);
      const [given] = progress.exhausted;
      expect(given?.reason).toBe("max_attempts_exceeded");
      expect(given?.terminalMessage.length).toBeGreaterThan(0);
      expect(given?.recoveryRootRequestId).toBe(
        progress.recoveryCalls[0]?.recoveryRootRequestId
      );
      expect(progress.recoveryCalls.length).toBeLessThanOrEqual(2);
    }, 30_000);

    it("ends recovery with recovery_aborted when shouldKeepRecovering says no", async () => {
      const progress = await recoverUntil(
        "budget-declined",
        {
          afterParts: 0,
          stalledCalls: 10,
          maxAttempts: 10,
          keepRecovering: false
        },
        (p) => p.exhausted.length > 0
      );

      expect(progress.exhausted.map((entry) => entry.reason)).toEqual([
        "recovery_aborted"
      ]);
    }, 30_000);
  });
});
