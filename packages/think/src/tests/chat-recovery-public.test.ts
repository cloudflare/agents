/**
 * Chat recovery as an app sees it: a model stream that stalls, the app's
 * `chatRecovery` and `onChatRecovery`, and what the conversation holds once
 * the agent is stable. Public API only, so it runs on Think and on the
 * harness-backed Think alike.
 */
import { env, exports } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it, vi } from "vitest";
import { subscribe } from "agents/observability";

async function freshAgent(name: string) {
  return getAgentByName(env.ThinkTestAgent, `${name}-${crypto.randomUUID()}`);
}

/** Reset the agent's isolate mid-turn, as an eviction does, and wait for
 * the next start's recovery to ask onChatRecovery. */
async function resetDuringTurn(
  name: string,
  chunksBeforeReset: number,
  answer?: { continue?: boolean; persist?: boolean },
  options?: { holdRecovery?: boolean; openedStream?: boolean }
) {
  const room = `${name}-${crypto.randomUUID()}`;
  const agent = () => getAgentByName(env.ThinkTestAgent, room);
  if (answer) await (await agent()).answerRecoveryForTest(answer);
  if (options?.holdRecovery) await (await agent()).holdRecoveryOnceForTest();
  const startedAt = Date.now();
  if (options?.openedStream) {
    // A stream opens, and its first chunk is slow to come.
    await (await agent()).useSlowModelForTest(["late "], 5_000);
  } else if (chunksBeforeReset === 0) {
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
  const userId = crypto.randomUUID();
  let chunks = 0;
  let opened = false;
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as {
      type?: string;
      body?: string;
      done?: boolean;
    };
    if (frame.type !== "cf_agent_use_chat_response" || frame.done) return;
    opened = true;
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
              id: userId,
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
        options?.openedStream
          ? opened && chunks === 0
          : chunksBeforeReset === 0
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
  return { requestId, calls, startedAt, resetAt, agent, room, userId };
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
  it("recovers a continuation a reset cut off after a tool answer: the tool's result once, then the text to its end", async () => {
    const room = `slow-continuation-${crypto.randomUUID()}`;
    const agent = () => getAgentByName(env.ThinkTestAgent, room);
    await (await agent()).askClientToolThenAnswerSlowlyForTest();
    const tab = async () => {
      const res = await exports.default.fetch(
        `http://example.com/agents/think-test-agent/${room}`,
        { headers: { Upgrade: "websocket" } }
      );
      const ws = res.webSocket;
      if (!ws) throw new Error("no socket");
      ws.accept();
      return ws;
    };
    const frames: Array<{ type?: string; body?: string; done?: boolean }> = [];
    const ws = await tab();
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as {
        type?: string;
        id?: string;
      };
      frames.push(frame);
      // As useAgentChat does: take the continuation's stream when offered.
      if (frame.type === "cf_agent_stream_resuming") {
        ws.send(
          JSON.stringify({ type: "cf_agent_stream_resume_ack", id: frame.id })
        );
      }
    });
    ws.send(
      JSON.stringify({
        type: "cf_agent_use_chat_request",
        id: crypto.randomUUID(),
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: crypto.randomUUID(),
                role: "user",
                parts: [{ type: "text", text: "confirm it with me" }]
              }
            ],
            clientTools: [
              { name: "client_action", description: "A client tool" }
            ]
          })
        }
      })
    );
    // The model has asked the client's tool; the client answers it.
    await vi.waitFor(
      () =>
        expect(
          frames.some((frame) => frame.body?.includes('"tool-input-available"'))
        ).toBe(true),
      { timeout: 10_000, interval: 20 }
    );
    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId: "tc-slow",
        toolName: "client_action",
        output: { confirmed: true },
        autoContinue: true
      })
    );
    // The continuation streams a little; then the isolate resets.
    await vi.waitFor(
      () =>
        expect(
          frames.filter((frame) => frame.body?.includes('"text-delta"')).length
        ).toBeGreaterThanOrEqual(2),
      { timeout: 10_000, interval: 20 }
    );
    await (await agent()).resetIsolateForTest().catch(() => undefined);
    ws.close();

    await vi.waitFor(
      async () =>
        expect(await (await agent()).lastAssistantTextForTest()).toContain(
          "c11 "
        ),
      { timeout: 20_000, interval: 100 }
    );
    const messages = (await (await agent()).getMessages()) as Array<{
      role: string;
      parts: Array<{
        type: string;
        toolCallId?: string;
        state?: string;
        output?: unknown;
      }>;
    }>;
    // Whether the continuation is the answered message or a second one is
    // Q10's ground; either way the recovery repeats nothing: the tool's call
    // and result once, and the continued text ends the reply once.
    const parts = messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.parts)
      .filter((part) => part.type !== "step-start");
    expect(parts.filter((part) => part.toolCallId === "tc-slow")).toMatchObject(
      [{ state: "output-available", output: { confirmed: true } }]
    );
    const text = parts
      .map((part) =>
        part.type === "text" ? (part as { text?: string }).text : ""
      )
      .join("");
    // What the reset cut off is kept, and the recovered call ends it once.
    expect(text.startsWith("c0 ")).toBe(true);
    expect(text.split("c11 ").length - 1).toBe(1);
    expect(parts.at(-1)?.type).toBe("text");
  }, 60_000);

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
        progressing?: boolean;
        maxRecoveryWork?: number;
        noProgressTimeoutMs?: number;
      },
      done: (progress: {
        recoveryCalls: Array<{ calledAt: number }>;
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
      // A give-up has ended the turn only once the agent is idle, with no
      // turn running and no recovery left to run: count after that, not at
      // the first onExhausted. (Think sends the terminal message to the
      // tabs; it is not stored as the reply, so the reply can't be the
      // barrier.)
      if (progress.exhausted.length > 0) {
        await vi.waitFor(
          async () => {
            expect(await agent.stableWithinForTest(2_000)).toBe(true);
          },
          { timeout: 20_000, interval: 50 }
        );
        progress = await agent.recoveryProgressForTest();
      }
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
      // Both attempts were spent before the give-up.
      expect(progress.recoveryCalls).toHaveLength(2);
    }, 30_000);

    // Arch's ruling: a live interruption (a stall) is one more scheduled
    // retry, capped by maxAttempts whatever the progress. onChatRecovery's
    // `attempt` is the count that resets when the last attempt made progress.
    it("tells onChatRecovery attempt 1 each time a stalled turn has made progress", async () => {
      const progress = await recoverUntil(
        "attempt-progress",
        { afterParts: 25, stalledCalls: 2, maxAttempts: 5, progressing: true },
        (p) => p.lastAssistantText.includes("a3-29")
      );

      expect(progress.recoveryCalls.map((call) => call.attempt)).toEqual([
        1, 1
      ]);
      expect(progress.exhausted).toEqual([]);
    }, 30_000);

    it("gives a stalled turn up at stall maxAttempts + 1 even when every attempt makes progress", async () => {
      const progress = await recoverUntil(
        "give-up-with-progress",
        { afterParts: 25, stalledCalls: 10, maxAttempts: 2, progressing: true },
        (p) => p.exhausted.length > 0
      );

      expect(progress.recoveryCalls).toHaveLength(2);
      expect(progress.exhausted.map((entry) => entry.reason)).toEqual([
        "max_attempts_exceeded"
      ]);
    }, 30_000);

    it("seals a turn that keeps making progress once the work budget is spent", async () => {
      const progress = await recoverUntil(
        "work-budget",
        {
          afterParts: 25,
          stalledCalls: 10,
          maxAttempts: 10,
          progressing: true,
          maxRecoveryWork: 2
        },
        (p) => p.exhausted.length > 0
      );

      expect(progress.exhausted.map((entry) => entry.reason)).toEqual([
        "work_budget_exceeded"
      ]);
    }, 30_000);

    // The no-progress window (#1637), with a short `noProgressTimeoutMs` in
    // place of the 5-minute default: elapsed time ends recovery only when
    // nothing moved.
    it("keeps recovering a turn that makes progress past the no-progress window, then answers", async () => {
      const progress = await recoverUntil(
        "progress-survives",
        {
          afterParts: 25,
          stalledCalls: 12,
          maxAttempts: 50,
          progressing: true,
          noProgressTimeoutMs: 300
        },
        (p) => p.exhausted.length > 0 || p.lastAssistantText.includes("a13-29")
      );

      expect(progress.exhausted).toEqual([]);
      expect(progress.recoveryCalls.length).toBeGreaterThanOrEqual(12);
      // The window was crossed: recovery went on checking well after
      // noProgressTimeoutMs had passed since the first interruption.
      const calledAt = progress.recoveryCalls.map((call) => call.calledAt);
      expect(calledAt.at(-1)! - calledAt[0]!).toBeGreaterThan(300);
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

  // Successors of the persist/continue tests (think-session, "Think —
  // onChatRecovery"): what a reset-interrupted turn leaves when
  // onChatRecovery declines.
  describe("onChatRecovery's answer after a reset", () => {
    async function settle(
      agent: Awaited<ReturnType<typeof resetDuringTurn>>["agent"]
    ) {
      await vi.waitFor(
        async () => {
          expect(await (await agent()).stableWithinForTest(2_000)).toBe(true);
        },
        { timeout: 15_000, interval: 50 }
      );
      return (await (await agent()).getMessages()) as Array<{
        id: string;
        role: string;
        parts: Array<{ type: string; text?: string }>;
      }>;
    }

    it("keeps the partial but runs no continuation when onChatRecovery says continue: false", async () => {
      const { agent } = await resetDuringTurn("answer-no-continue", 2, {
        continue: false
      });
      const messages = await settle(agent);

      expect(messages.map((message) => message.role)).toEqual([
        "user",
        "assistant"
      ]);
      const text = messages[1]?.parts
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
      // Only what the reset left: the reply was not continued.
      expect(text).toMatch(/^one /);
      expect(text).not.toContain("six");
      // No model call or continuation ran after the reset.
      expect(await (await agent()).modelCallsForTest()).toBe(0);
    }, 30_000);

    it("tells a tab that reconnects after onChatRecovery says continue: false that the turn ended in an error", async () => {
      const { agent, room } = await resetDuringTurn(
        "answer-no-continue-tab",
        2,
        {
          continue: false
        }
      );
      await settle(agent);

      // A tab coming back finds the turn ended, not frozen half-streamed.
      const res = await exports.default.fetch(
        `http://example.com/agents/think-test-agent/${room}`,
        { headers: { Upgrade: "websocket" } }
      );
      const ws = res.webSocket;
      if (!ws) throw new Error("no socket");
      const errors: string[] = [];
      ws.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as {
          type?: string;
          error?: boolean;
          body?: string;
          id?: string;
        };
        // The tab takes up the stream it is offered, as useChat does.
        if (frame.type === "cf_agent_stream_resuming") {
          ws.send(
            JSON.stringify({ type: "cf_agent_stream_resume_ack", id: frame.id })
          );
        }
        if (frame.type === "cf_agent_use_chat_response" && frame.error) {
          errors.push(frame.body ?? "");
        }
      });
      ws.accept();
      ws.send(JSON.stringify({ type: "cf_agent_stream_resume_request" }));
      await vi.waitFor(() => expect(errors).toHaveLength(1), {
        timeout: 10_000,
        interval: 20
      });
      ws.close();

      expect(errors[0]).toContain("automatic continuation was declined");
    }, 30_000);

    // Successors of the pre-stream retry tests (think-session, "Think —
    // onChatRecovery"): a turn cut off before its first chunk is asked again.
    it("answers a turn a reset cut off after its stream opened but before any text", async () => {
      const { agent, userId } = await resetDuringTurn(
        "retry-opened",
        0,
        undefined,
        {
          openedStream: true
        }
      );
      const messages = await settle(agent);

      expect(messages.map((message) => message.role)).toEqual([
        "user",
        "assistant"
      ]);
      // The same question, asked once more: one model call after the reset.
      expect(messages[0]?.id).toBe(userId);
      expect(await (await agent()).modelCallsForTest()).toBe(1);
      expect(
        messages[1]?.parts.some(
          (part) => part.type === "text" && (part.text ?? "").length > 0
        )
      ).toBe(true);
    }, 30_000);

    it("answers a turn a reset cut off before its first chunk, with its user message once", async () => {
      const { agent } = await resetDuringTurn("retry-pre-stream", 0);
      const messages = await settle(agent);

      expect(messages.map((message) => message.role)).toEqual([
        "user",
        "assistant"
      ]);
      expect(
        messages[1]?.parts.some(
          (part) => part.type === "text" && (part.text ?? "").length > 0
        )
      ).toBe(true);
    }, 30_000);

    it("drops the partial and answers the question again when onChatRecovery says persist: false", async () => {
      const { agent } = await resetDuringTurn("answer-persist-false", 2, {
        persist: false
      });
      const messages = await settle(agent);

      expect(messages.map((message) => message.role)).toEqual([
        "user",
        "assistant"
      ]);
      const text = messages[1]?.parts
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
      // A new answer, with nothing of what the reset cut off.
      expect(text).not.toMatch(/one /);
      expect(text?.length).toBeGreaterThan(0);
      expect(await (await agent()).modelCallsForTest()).toBe(1);
    }, 30_000);

    it("keeps nothing and runs nothing when onChatRecovery says persist: false, continue: false", async () => {
      const { agent } = await resetDuringTurn("answer-drop", 2, {
        persist: false,
        continue: false
      });
      const messages = await settle(agent);

      expect(messages.map((message) => message.role)).toEqual(["user"]);
    }, 30_000);
  });

  // Successor of the interrupted-attempts bound (think-session, "Think —
  // onChatRecovery", the work-budget and progress tests): resets that each
  // land after some progress go on past maxAttempts, and stop at
  // maxInterruptedAttempts, which never resets.
  it("recovers past maxAttempts across resets that each follow progress, until maxInterruptedAttempts", async () => {
    const room = `resets-bound-${crypto.randomUUID()}`;
    const agent = () => getAgentByName(env.ThinkTestAgent, room);
    const exhausted: Array<{ reason?: string }> = [];
    const unsubscribe = subscribe("chat", (event) => {
      if (event.type === "chat:recovery:exhausted" && event.name === room) {
        exhausted.push(event.payload as { reason?: string });
      }
    });
    /** A tab, counting the text chunks it is sent. */
    async function connect() {
      const res = await exports.default.fetch(
        `http://example.com/agents/think-test-agent/${room}`,
        { headers: { Upgrade: "websocket" } }
      );
      const ws = res.webSocket;
      if (!ws) throw new Error("no socket");
      ws.accept();
      const tab = { ws, chunks: 0 };
      ws.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as {
          type?: string;
          id?: string;
          body?: string;
          replay?: boolean;
        };
        // As a chat client does: take up a stream it is offered.
        if (frame.type === "cf_agent_stream_resuming") {
          ws.send(
            JSON.stringify({ type: "cf_agent_stream_resume_ack", id: frame.id })
          );
        }
        // New text only: a replay of what was streamed is not progress.
        if (
          frame.type === "cf_agent_use_chat_response" &&
          !frame.replay &&
          frame.body?.includes("text-delta")
        ) {
          tab.chunks++;
        }
      });
      return tab;
    }
    try {
      await (
        await agent()
      ).keepAcrossResetsForTest({
        chunks: Array.from({ length: 200 }, (_, k) => `w${k} `),
        delayMs: 40,
        config: { maxAttempts: 1, maxInterruptedAttempts: 3 }
      });
      let tab = await connect();
      tab.ws.send(
        JSON.stringify({
          type: "cf_agent_use_chat_request",
          id: crypto.randomUUID(),
          init: {
            method: "POST",
            body: JSON.stringify({
              messages: [
                {
                  id: crypto.randomUUID(),
                  role: "user",
                  parts: [{ type: "text", text: "reset me, again" }]
                }
              ]
            })
          }
        })
      );
      let resets = 0;
      for (;;) {
        // Some new text reached the tab: this attempt made progress.
        await vi.waitFor(
          () => {
            expect(tab.chunks >= 3 || exhausted.length > 0).toBe(true);
          },
          { timeout: 15_000, interval: 20 }
        );
        if (exhausted.length > 0 || resets >= 6) break;
        await (await agent()).resetIsolateForTest().catch(() => undefined);
        resets++;
        tab.ws.close();
        // A new tab wakes the agent, whose start recovers the turn.
        tab = await connect();
      }
      tab.ws.close();

      // Past maxAttempts (1): more than one reset was recovered. Stopped at
      // maxInterruptedAttempts (3), which progress does not reset.
      // maxInterruptedAttempts 3: the first two resets are recovered, past
      // maxAttempts (1); the third ends it.
      expect(resets).toBe(3);
      expect(exhausted.map((entry) => entry.reason)).toEqual([
        "interrupted_attempts_exceeded"
      ]);
    } finally {
      unsubscribe();
    }
  }, 90_000);

  // Successor of the regeneration tests (think-session, "Think —
  // onChatRecovery", #2028): a regeneration a reset cut off is finished on
  // its own new branch, and the earlier answer is kept.
  it("finishes a regeneration a reset cut off on its new branch, keeping the earlier answer", async () => {
    const room = `regen-reset-${crypto.randomUUID()}`;
    const agent = () => getAgentByName(env.ThinkTestAgent, room);
    async function tab() {
      const res = await exports.default.fetch(
        `http://example.com/agents/think-test-agent/${room}`,
        { headers: { Upgrade: "websocket" } }
      );
      const ws = res.webSocket;
      if (!ws) throw new Error("no socket");
      ws.accept();
      const seen = { chunks: 0, done: 0 };
      ws.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as {
          type?: string;
          body?: string;
          done?: boolean;
        };
        if (frame.type !== "cf_agent_use_chat_response") return;
        if (frame.done) seen.done++;
        else if (frame.body?.includes("text-delta")) seen.chunks++;
      });
      return { ws, seen };
    }
    const send = (ws: WebSocket, body: Record<string, unknown>) =>
      ws.send(
        JSON.stringify({
          type: "cf_agent_use_chat_request",
          id: crypto.randomUUID(),
          init: { method: "POST", body: JSON.stringify(body) }
        })
      );
    const user = {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: "explain monads" }]
    };

    const first = await tab();
    send(first.ws, { messages: [user] });
    await vi.waitFor(() => expect(first.seen.done).toBe(1), {
      timeout: 10_000,
      interval: 20
    });
    const [, earlier] = (await (await agent()).getMessages()) as Array<{
      id: string;
    }>;

    await (
      await agent()
    ).useSlowModelForTest(
      ["one ", "two ", "three ", "four ", "five ", "six "],
      150
    );
    send(first.ws, { messages: [user], trigger: "regenerate-message" });
    await vi.waitFor(
      () => expect(first.seen.chunks).toBeGreaterThanOrEqual(2),
      {
        timeout: 10_000,
        interval: 20
      }
    );
    await (await agent()).resetIsolateForTest().catch(() => undefined);
    first.ws.close();

    // A new tab wakes the agent; its start recovers the regeneration.
    const second = await tab();
    await vi.waitFor(
      async () => {
        expect(await (await agent()).stableWithinForTest(2_000)).toBe(true);
        const branches = await (await agent()).getBranchesForTest(user.id);
        expect(branches).toHaveLength(2);
      },
      { timeout: 20_000, interval: 100 }
    );
    second.ws.close();

    const branches = [
      ...((await (await agent()).getBranchesForTest(user.id)) as Array<{
        id: string;
        parts: Array<{ type: string; text?: string }>;
      }>)
    ];
    expect(branches.map((message) => message.id)).toContain(earlier?.id);
    const regenerated = branches.find((message) => message.id !== earlier?.id);
    const text = (regenerated?.parts ?? [])
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    expect(text).toMatch(/^one /);
    // Finished after the reset: the fresh isolate's model wrote the rest.
    expect(text).toContain("Hello from the assistant!");
    // The regenerated branch is the one the conversation now shows.
    const shown = (await (await agent()).getMessages()) as Array<{
      id: string;
    }>;
    expect(shown.at(-1)?.id).toBe(regenerated?.id);
  }, 60_000);

  it("retries a regeneration a reset cut off before its first chunk as a new branch, keeping the earlier answer", async () => {
    const room = `regen-pre-${crypto.randomUUID()}`;
    const agent = () => getAgentByName(env.ThinkTestAgent, room);
    async function tab() {
      const res = await exports.default.fetch(
        `http://example.com/agents/think-test-agent/${room}`,
        { headers: { Upgrade: "websocket" } }
      );
      const ws = res.webSocket;
      if (!ws) throw new Error("no socket");
      ws.accept();
      const seen = { chunks: 0, done: 0 };
      ws.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as {
          type?: string;
          body?: string;
          done?: boolean;
        };
        if (frame.type !== "cf_agent_use_chat_response") return;
        if (frame.done) seen.done++;
        else if (frame.body?.includes("text-delta")) seen.chunks++;
      });
      return { ws, seen };
    }
    const send = (ws: WebSocket, body: Record<string, unknown>) =>
      ws.send(
        JSON.stringify({
          type: "cf_agent_use_chat_request",
          id: crypto.randomUUID(),
          init: { method: "POST", body: JSON.stringify(body) }
        })
      );
    const user = {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: "explain monads" }]
    };

    const first = await tab();
    send(first.ws, { messages: [user] });
    await vi.waitFor(() => expect(first.seen.done).toBe(1), {
      timeout: 10_000,
      interval: 20
    });
    const [, earlier] = (await (await agent()).getMessages()) as Array<{
      id: string;
      parts: unknown[];
    }>;

    await (await agent()).hangModelAtConnectForTest();
    send(first.ws, { messages: [user], trigger: "regenerate-message" });
    // Before any stream: the regeneration's model call waits on the provider.
    await vi.waitFor(
      async () => {
        expect(await (await agent()).modelConnectingForTest()).toBe(true);
      },
      { timeout: 10_000, interval: 20 }
    );
    await (await agent()).resetIsolateForTest().catch(() => undefined);
    first.ws.close();

    // A new tab wakes the agent; its start recovers the regeneration.
    const second = await tab();
    await vi.waitFor(
      async () => {
        expect(await (await agent()).stableWithinForTest(2_000)).toBe(true);
        const branches = await (await agent()).getBranchesForTest(user.id);
        expect(branches).toHaveLength(2);
      },
      { timeout: 20_000, interval: 100 }
    );
    second.ws.close();

    const branches = [
      ...((await (await agent()).getBranchesForTest(user.id)) as Array<{
        id: string;
        parts: Array<{ type: string; text?: string }>;
      }>)
    ];
    expect(branches.map((message) => message.id)).toContain(earlier?.id);
    const regenerated = branches.find((message) => message.id !== earlier?.id);
    const text = (regenerated?.parts ?? [])
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    // Asked again from the start, so a whole answer.
    expect(text.length).toBeGreaterThan(0);
    // The earlier answer is unchanged, and the regenerated one is shown.
    expect(
      branches.find((message) => message.id === earlier?.id)?.parts
    ).toEqual(earlier?.parts);
    const shown = (await (await agent()).getMessages()) as Array<{
      id: string;
    }>;
    expect(shown.at(-1)?.id).toBe(regenerated?.id);
    // One model call after the reset, and it was not sent the old answer.
    const prompts = await (await agent()).getModelPromptsForTest();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.some((line) => line.startsWith("assistant:"))).toBe(
      false
    );
  }, 60_000);

  // Successor of the platform-reset tests (think-session, "Think —
  // onChatRecovery", #1730/#2613): a recovery attempt the platform cuts
  // (here, a reset while onChatRecovery is running) does not end the turn:
  // the next start runs the recovery again, and no terminal is sent.
  it("re-runs a recovery a reset cut while onChatRecovery ran, and sends no terminal", async () => {
    const exhausted: unknown[] = [];
    let room = "";
    const unsubscribe = subscribe("chat", (event) => {
      if (event.type === "chat:recovery:exhausted" && event.name === room) {
        exhausted.push(event.payload);
      }
    });
    try {
      // First reset: mid-reply. Its recovery's onChatRecovery is held.
      const first = await resetDuringTurn("platform-cut", 2, undefined, {
        holdRecovery: true
      });
      room = first.room;
      const agent = first.agent;
      await vi.waitFor(
        async () => {
          expect((await (await agent()).recoveryHoldForTest()).held).toBe(true);
        },
        { timeout: 15_000, interval: 50 }
      );
      // The platform cuts the recovery attempt: reset while the hook runs.
      await (await agent()).resetIsolateForTest().catch(() => undefined);

      // A tab wakes the agent; its start runs the recovery again.
      const res = await exports.default.fetch(
        `http://example.com/agents/think-test-agent/${room}`,
        { headers: { Upgrade: "websocket" } }
      );
      const ws = res.webSocket;
      if (!ws) throw new Error("no socket");
      ws.accept();
      const errors: unknown[] = [];
      ws.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as {
          type?: string;
          error?: boolean;
        };
        if (frame.type === "cf_agent_use_chat_response" && frame.error) {
          errors.push(frame);
        }
      });
      await vi.waitFor(
        async () => {
          expect(
            (await (await agent()).recoveryHoldForTest()).calls
          ).toBeGreaterThanOrEqual(2);
          expect(await (await agent()).stableWithinForTest(2_000)).toBe(true);
        },
        { timeout: 20_000, interval: 100 }
      );
      ws.close();

      expect(exhausted).toEqual([]);
      expect(errors).toEqual([]);
      expect(
        (await (await agent()).lastAssistantTextForTest()).length
      ).toBeGreaterThan(0);
    } finally {
      unsubscribe();
    }
  }, 60_000);

  // The no-progress window (#1637, 4704's promise for a parent whose child
  // is silent): interruptions found after resets, with nothing written in
  // between, end once the window has passed, with a short
  // `noProgressTimeoutMs` in place of the 5-minute default.
  it("seals a turn whose resets bring no progress once the no-progress window passes", async () => {
    const room = `no-progress-${crypto.randomUUID()}`;
    const agent = () => getAgentByName(env.ThinkTestAgent, room);
    const exhausted: Array<{ reason?: string }> = [];
    const unsubscribe = subscribe("chat", (event) => {
      if (event.type === "chat:recovery:exhausted" && event.name === room) {
        exhausted.push(event.payload as { reason?: string });
      }
    });
    // Terminal errors the last tab opened was sent; earlier tabs don't count.
    let terminalErrors = 0;
    let tabs = 0;
    async function tab() {
      const res = await exports.default.fetch(
        `http://example.com/agents/think-test-agent/${room}`,
        { headers: { Upgrade: "websocket" } }
      );
      const ws = res.webSocket;
      if (!ws) throw new Error("no socket");
      ws.accept();
      const tabNumber = ++tabs;
      terminalErrors = 0;
      ws.addEventListener("message", (event) => {
        if (tabNumber !== tabs) return;
        const frame = JSON.parse(String(event.data)) as {
          type?: string;
          error?: boolean;
        };
        if (frame.type === "cf_agent_use_chat_response" && frame.error) {
          terminalErrors++;
        }
      });
      return ws;
    }
    try {
      await (
        await agent()
      ).hangAcrossResetsForTest({
        maxAttempts: 50,
        maxInterruptedAttempts: 50,
        noProgressTimeoutMs: 300
      });
      let ws = await tab();
      ws.send(
        JSON.stringify({
          type: "cf_agent_use_chat_request",
          id: crypto.randomUUID(),
          init: {
            method: "POST",
            body: JSON.stringify({
              messages: [
                {
                  id: crypto.randomUUID(),
                  role: "user",
                  parts: [{ type: "text", text: "never answered" }]
                }
              ]
            })
          }
        })
      );
      let resets = 0;
      for (;;) {
        // The attempt waits on the provider: no progress.
        await vi.waitFor(
          async () => {
            expect(
              exhausted.length > 0 ||
                (await (await agent()).modelConnectingForTest())
            ).toBe(true);
          },
          { timeout: 15_000, interval: 20 }
        );
        if (exhausted.length > 0 || resets >= 20) break;
        await (await agent()).resetIsolateForTest().catch(() => undefined);
        resets++;
        ws.close();
        ws = await tab();
      }
      // The open tab is told the turn ended in an error.
      await vi.waitFor(() => expect(terminalErrors).toBeGreaterThan(0), {
        timeout: 15_000,
        interval: 20
      });
      await vi.waitFor(
        async () => {
          expect(await (await agent()).stableWithinForTest(2_000)).toBe(true);
        },
        { timeout: 15_000, interval: 50 }
      );
      // The open tab is told the turn ended in an error, once.
      expect(terminalErrors).toBe(1);
      ws.close();

      expect(exhausted.map((entry) => entry.reason)).toEqual([
        "no_progress_timeout"
      ]);
    } finally {
      unsubscribe();
    }
  }, 90_000);

  // Successor of think-session's "PARKS a continuation … while a CLIENT
  // interaction is pending": a turn waiting on
  // the client's tool is not stuck, so a reset there spends no attempt and
  // gives nothing up, and the client's answer finishes the reply.
  it("waits for the client's tool answer after a reset, giving nothing up, then finishes the reply", async () => {
    const room = `client-wait-${crypto.randomUUID()}`;
    const agent = () => getAgentByName(env.ThinkTestAgent, room);
    const exhausted: unknown[] = [];
    const skipped: Array<{ reason?: string; recoveryKind?: string }> = [];
    const unsubscribe = subscribe("chat", (event) => {
      if (event.name !== room) return;
      if (event.type === "chat:recovery:exhausted") {
        exhausted.push(event.payload);
      }
      if (event.type === "chat:recovery:skipped") {
        skipped.push(
          event.payload as { reason?: string; recoveryKind?: string }
        );
      }
    });
    const frames: Array<{ type?: string; body?: string; error?: boolean }> = [];
    async function tab() {
      const res = await exports.default.fetch(
        `http://example.com/agents/think-test-agent/${room}`,
        { headers: { Upgrade: "websocket" } }
      );
      const ws = res.webSocket;
      if (!ws) throw new Error("no socket");
      ws.addEventListener("message", (event) => {
        frames.push(JSON.parse(String(event.data)));
      });
      ws.accept();
      return ws;
    }
    try {
      await (
        await agent()
      ).askClientToolAcrossResetsForTest({
        stableTimeoutMs: 200
      });
      let ws = await tab();
      ws.send(
        JSON.stringify({
          type: "cf_agent_use_chat_request",
          id: crypto.randomUUID(),
          init: {
            method: "POST",
            body: JSON.stringify({
              messages: [
                {
                  id: crypto.randomUUID(),
                  role: "user",
                  parts: [{ type: "text", text: "confirm it with me" }]
                }
              ],
              clientTools: [
                { name: "client_action", description: "A client tool" }
              ]
            })
          }
        })
      );
      // The model has asked the client's tool.
      await vi.waitFor(
        () =>
          expect(
            frames.some((frame) =>
              frame.body?.includes('"tool-input-available"')
            )
          ).toBe(true),
        { timeout: 10_000, interval: 20 }
      );
      await (await agent()).resetIsolateForTest().catch(() => undefined);
      ws.close();
      ws = await tab();
      // Recovery finds the turn waiting on the client, and leaves it to the
      // client's answer.
      await vi.waitFor(
        () =>
          expect(skipped).toMatchObject([
            { reason: "awaiting_client_interaction", recoveryKind: "continue" }
          ]),
        { timeout: 15_000, interval: 20 }
      );

      // Nothing given up, and the model not asked again: the turn waits.
      expect(exhausted).toEqual([]);
      expect(await (await agent()).modelCallsForTest()).toBe(0);
      const waiting = (await (await agent()).getMessages()) as Array<{
        role: string;
        parts: Array<{ type: string; state?: string }>;
      }>;
      expect(waiting.map((message) => message.role)).toEqual([
        "user",
        "assistant"
      ]);
      expect(
        waiting[1]?.parts.find((part) => part.type === "tool-client_action")
          ?.state
      ).toBe("input-available");

      // The client answers, and the reply goes on.
      ws.send(
        JSON.stringify({
          type: "cf_agent_tool_result",
          toolCallId: "tc-client",
          toolName: "client_action",
          output: { confirmed: true },
          autoContinue: true
        })
      );
      await vi.waitFor(
        async () => {
          expect(await (await agent()).lastAssistantTextForTest()).toContain(
            "Done after the client"
          );
        },
        { timeout: 15_000, interval: 50 }
      );
      ws.close();
      expect(exhausted).toEqual([]);
      expect(frames.some((frame) => frame.error)).toBe(false);
    } finally {
      unsubscribe();
    }
  }, 60_000);
});
