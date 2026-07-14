import { describe, expect, it, vi } from "vitest";
import { AbortedError } from "../kernel/errors.js";
import { createMemoryHost, type MemoryHost } from "../adapters/memory/host.js";
import { createFakeModel } from "../adapters/memory/fake-model.js";
import type { IdSource } from "../kernel/ids.js";
import type { ModelClient, ModelRequest } from "../ports/model.js";
import type { RecoveryPolicy } from "../domain/reliability/recovery/recovery.js";
import type { ConversationEvent, StoredEvent } from "../domain/events/log.js";
import type { AgentHost } from "../app/agent.js";
import { Think, type SessionBuilder } from "../app/think.js";

/**
 * Scenario 4 (audit 24 §4): interruption, stall, and overflow recovery.
 *
 * This file also probes two areas the Think module tests only lightly cover
 * (per think.test.ts's own note above its "recovery basics" describe block):
 * a *second* Think instance recovering an interrupted turn from the same
 * durable store (a true "eviction", not just a same-process stall), and the
 * retry-vs-continuation distinction (audit 14 §1: "retry" replays a turn
 * that never produced assistant output; "continue" resumes from a partial
 * one). Probing the latter surfaced a genuine gap — see the fix note below.
 *
 * Fix made in src/app/think.ts (reported in full to the caller): the chat
 * recovery service's `scheduleRetry` and `scheduleContinuation` callbacks
 * both funneled into one `scheduleRecoveryRun` helper that re-ran the turn
 * with `newMessages: []` and nothing else. That's correct for a retry (the
 * user's message was already durably appended to session history before the
 * fiber-wrapped model call, so replaying just means re-running over existing
 * history) but silently wrong for a continuation: the partial assistant
 * message buffered mid-stream is only ever written to `turnState`'s scratch
 * key, never appended to session history, because `finalizeOutcome` — the
 * only code path that appends it — never runs when the turn is cut off by an
 * eviction or a stall abort. Left as it was, "continuation" and "retry"
 * behaved identically: the model would regenerate a fresh reply with no
 * memory of what it had already said. Split the shared helper into
 * `scheduleRecoveryRetry` (unchanged behavior) and
 * `scheduleRecoveryContinuation`, which now calls
 * `turnState.commitInterruptedPartial()` to append the repaired partial
 * (reusing the same `repairTranscript`/`repairInterruptedToolPart` machinery
 * `history()` already uses for the live transcript) to session history
 * *before* re-running the turn. The tests below exercise both the stall path
 * (b) and this deep-recovery path (a) and would have passed trivially under
 * the old, indistinguishable-continuation behavior — the assertions on the
 * *number* of model calls and on the appended partial text are what pin the
 * fix down.
 *
 * Wave R2 update: this file previously drove interactions through the
 * `cf_agent_*` frame protocol over `agent.onMessage(conn, ...)`. Transport is
 * now entirely an adapter concern (audit 25) — this rewrite calls `chat()`
 * directly and asserts against the agent's own `ConversationEvent` log
 * instead of frames; the WS adapter (wave R3) re-covers the frame-level path.
 */

function counterIds(): IdSource {
  let n = 0;
  return { newId: (prefix: string) => `${prefix}_${++n}` };
}

function toHost(mem: MemoryHost, opts: Partial<AgentHost> & { className: string; name: string }): AgentHost {
  return {
    store: mem.store,
    alarm: mem.alarms,
    clock: mem.clock,
    ids: counterIds(),
    ...opts,
  };
}

function eventsOfType<T extends ConversationEvent["type"]>(
  events: StoredEvent[],
  type: T,
): Array<Extract<ConversationEvent, { type: T }>> {
  return events.map((e) => e.event).filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);
}

class RecoveryThink extends Think<unknown> {
  model!: ModelClient;
  compactionSummarize: ((prompt: string) => Promise<string>) | undefined;

  protected override getModel(): ModelClient {
    return this.model;
  }
  protected override getSystemPrompt(): string {
    return "You are a resilient assistant.";
  }

  protected override configureSession(builder: SessionBuilder): SessionBuilder {
    if (this.compactionSummarize) {
      builder.onCompaction(this.compactionSummarize, { protectHead: 1, tailTokenBudget: 1, minTailMessages: 1 });
    }
    return builder;
  }
}

function makeAgent(
  mem = createMemoryHost({ agent: "RecoveryThink", name: "r1" }),
  ids?: IdSource,
): {
  agent: RecoveryThink;
  mem: MemoryHost;
} {
  const host = toHost(mem, { className: "RecoveryThink", name: "r1", ...(ids ? { ids } : {}) });
  const agent = new RecoveryThink(host);
  mem.attachAgent(agent);
  return { agent, mem };
}

/**
 * `vi.waitFor` polls using `Date.now()`-based timeout bookkeeping, which
 * `vi.useFakeTimers()` also freezes — combining the two spins forever (a real
 * observed hang/OOM, not a hypothetical). Under fake timers, settle pending
 * chains by repeatedly advancing by 0ms instead, which still flushes
 * microtasks/timer callbacks but never blocks on real wall-clock time.
 */
async function flushFakeTimers(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

/** Yields a leading text-delta chunk, then hangs until the request signal aborts. */
function partialThenHangModel(chunksBeforeHang: number): { model: ModelClient; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  const model: ModelClient = {
    async *stream(request) {
      requests.push(request);
      const n = requests.length;
      if (n <= chunksBeforeHang) {
        yield { type: "text-delta", text: `Partial answer ${n}, ` };
        await new Promise<never>((_resolve, reject) => {
          if (request.signal?.aborted) {
            reject(new AbortedError("aborted"));
            return;
          }
          request.signal?.addEventListener("abort", () => reject(new AbortedError("aborted")), { once: true });
        });
        return;
      }
      yield { type: "text-delta", text: "Finished after recovery." };
      yield { type: "finish", finishReason: "stop" };
    },
  };
  return { model, requests };
}

describe("e2e: chat recovery", () => {
  it("(a) a hang-then-answer model recovers via the stall watchdog and completes with a continuation that includes the earlier partial text", async () => {
    vi.useFakeTimers();
    try {
      const { agent } = makeAgent();
      const { model } = partialThenHangModel(1);
      agent.model = model;
      agent.chatStreamStallTimeoutMs = 50;
      await agent.start();

      const chatPromise = agent.chat("tell me a story", undefined, { requestId: "req_1" });
      await vi.advanceTimersByTimeAsync(50); // stall fires; original call returns "recovering"
      await chatPromise;
      await flushFakeTimers(); // let the fire-and-forget continuation settle

      const messages = await agent.getMessages();
      expect(messages.some((m) => m.parts.some((p) => p.type === "text" && p.text === "Finished after recovery."))).toBe(
        true,
      );
      // user + the interrupted partial (committed by the continuation fix) + the completed continuation reply.
      expect(messages).toHaveLength(3);
      expect(messages[1]!.parts.find((p) => p.type === "text")).toMatchObject({ text: "Partial answer 1, " });
      expect(messages[2]!.parts.find((p) => p.type === "text")).toMatchObject({ text: "Finished after recovery." });
    } finally {
      vi.useRealTimers();
    }
  });

  it("(a-deep) a second Think instance over the same store recovers an interrupted turn left by a hard eviction", async () => {
    const mem = createMemoryHost({ agent: "RecoveryThink", name: "r-deep" });
    // Shared across both instances, mirroring agent.test.ts's own eviction
    // convention: a real Durable Object recreation gets fresh (crypto-random,
    // never-colliding) ids, but this in-test counter resets to 0 per
    // `toHost()` call, so without sharing it agent2's first "msg"/"fiber" id
    // would collide with a row agent1 already wrote under the *same* shared
    // session ("main" — see the think.ts fix above) and corrupt the message
    // tree into a parent-chain cycle, hanging `Session.rawHistory()`'s walk
    // forever. Confirmed by direct repro during this investigation.
    const sharedIds = counterIds();
    const { agent: agent1 } = makeAgent(mem, sharedIds);
    const { model: hangModel, requests: hangRequests } = partialThenHangModel(1);
    agent1.model = hangModel;
    await agent1.start();

    // Kick off a turn and let it stream one partial chunk, then abandon this
    // instance entirely (no cancel, no clearMessages) — a hard eviction.
    void agent1.chat("tell me a story", undefined, { requestId: "req_1" });
    await vi.waitFor(() => expect(hangRequests).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 10)); // let the partial delta land

    // Fresh instance, same durable store: its own fiber service has no live
    // entry for the "chat-turn" fiber agent1 left running, so start()'s
    // checkInterrupted() scan treats it as orphaned and drives recovery.
    const { agent: agent2 } = makeAgent(mem, sharedIds);
    const finishModel = createFakeModel([{ kind: "text", text: "Recovered on a fresh instance." }]);
    agent2.model = finishModel;

    await agent2.start();

    await vi.waitFor(async () => {
      const messages = await agent2.getMessages();
      expect(
        messages.some((m) => m.parts.some((p) => p.type === "text" && p.text === "Recovered on a fresh instance.")),
      ).toBe(true);
    });

    const messages = await agent2.getMessages();
    expect(messages).toHaveLength(3);
    expect(messages[0]!.role).toBe("user");
    // The partial streamed by agent1 was committed to session history by the
    // continuation fix before agent2 re-ran the turn.
    expect(messages[1]!.parts.find((p) => p.type === "text")).toMatchObject({ text: "Partial answer 1, " });
    expect(messages[2]!.parts.find((p) => p.type === "text")).toMatchObject({ text: "Recovered on a fresh instance." });
  });

  it("(b) an always-hanging model exhausts recovery attempts and persists the configured terminal message", async () => {
    vi.useFakeTimers();
    try {
      const { agent } = makeAgent();
      agent.model = createFakeModel(() => ({ kind: "hang" }));
      agent.chatStreamStallTimeoutMs = 50;
      const policy: RecoveryPolicy = { maxAttempts: 1, terminalMessage: "Giving up after retries." };
      agent.chatRecovery = policy;
      await agent.start();

      const busEvents: Array<{ type: string; payload: unknown }> = [];
      agent.bus.subscribe("chat", (e) => busEvents.push(e));
      const events: StoredEvent[] = [];
      agent.events().subscribe("live", (e) => events.push(e));

      const chatPromise = agent.chat("hi", undefined, { requestId: "req_1" });
      await vi.advanceTimersByTimeAsync(50); // first stall -> attempt 1 scheduled (continuation)
      await chatPromise;

      await vi.advanceTimersByTimeAsync(50); // second stall on the continuation -> exhausted
      await flushFakeTimers();

      expect(busEvents.some((e) => e.type === "chat:recovery:exhausted")).toBe(true);

      const messages = await agent.getMessages();
      expect(messages.some((m) => m.parts.some((p) => p.type === "text" && p.text === "Giving up after retries."))).toBe(
        true,
      );
      const recovering = eventsOfType(events, "recovering:changed");
      expect(recovering[recovering.length - 1]).toMatchObject({ active: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("(c) an overflow-classified error triggers compaction and the retried turn succeeds", async () => {
    const { agent } = makeAgent();
    agent.contextOverflow = { reactive: true, maxRetries: 1 };
    // Short summary vs. a long first reply: the compaction plan (protectHead
    // 1, a tiny tail budget) always keeps the prior assistant message alone
    // in the compacted range, so the summary must be shorter than it for
    // `shortened` to come out true — a fixed-size summary against a short
    // original wouldn't reliably shrink the estimate.
    agent.compactionSummarize = async () => "Summary.";

    let call = 0;
    agent.model = createFakeModel(() => {
      call++;
      if (call === 1) return { kind: "text", text: "first reply, ".repeat(200) };
      if (call === 2) return { kind: "error", error: new Error("Input exceeds the model's context window.") };
      return { kind: "text", text: "Done after compaction." };
    });
    await agent.start();

    const busEvents: Array<{ type: string; payload: unknown }> = [];
    agent.bus.subscribe("chat", (e) => busEvents.push(e));

    // One prior turn so there's something to compact.
    await agent.chat("first question", undefined, { requestId: "req_0" });

    const result = await agent.chat("a very long follow-up", undefined, { requestId: "req_1" });

    expect(result.outcome).toBe("completed");
    const messages = await agent.getMessages();
    expect(messages[messages.length - 1]!.parts.find((p) => p.type === "text")).toMatchObject({
      text: "Done after compaction.",
    });

    const compactionEvents = busEvents.filter((e) => e.type === "chat:context:compacted");
    expect(compactionEvents).toHaveLength(1);
    expect(compactionEvents[0]!.payload).toMatchObject({ reason: "reactive", shortened: true });
  });
});
