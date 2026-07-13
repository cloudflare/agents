import { describe, expect, it, vi } from "vitest";
import { createMemoryAlarmTimer } from "../../adapters/memory/alarms.js";
import { createTestClock, type TestClock } from "../../adapters/memory/clock.js";
import { createMemoryKeyValueStore } from "../../adapters/memory/store.js";
import { createEventBus, type ObservabilityEvent } from "../../kernel/events.js";
import type { IdSource } from "../../kernel/ids.js";
import type { KeyValueStore } from "../../ports/storage.js";
import { createFiberService, type FiberService } from "../fibers/fibers.js";
import { createKeepAlive } from "../scheduling/keep-alive.js";
import { createScheduler } from "../scheduling/scheduler.js";
import { assistantMessage } from "../messages/model.js";
import type { ChatMessage } from "../messages/model.js";
import type { TurnOutcome } from "../turn/loop.js";
import { createChatRecovery, type ChatRecovery, type Incident, type RecoveryPolicy } from "./recovery.js";

function counterIds(prefix = ""): IdSource {
  let n = 0;
  return {
    newId(p: string) {
      n += 1;
      return `${prefix}${p}_${n}`;
    },
  };
}

interface ConversationFake {
  lastRequestId(): string | undefined;
  partialAssistant(requestId: string): ChatMessage | undefined;
  scheduleRetry: ReturnType<typeof vi.fn>;
  scheduleContinuation: ReturnType<typeof vi.fn>;
  terminalize: ReturnType<typeof vi.fn>;
  setLastRequestId(id: string | undefined): void;
  setPartial(requestId: string, message: ChatMessage | undefined): void;
}

function conversationFake(): ConversationFake {
  let last: string | undefined;
  const partials = new Map<string, ChatMessage>();
  return {
    lastRequestId: () => last,
    partialAssistant: (requestId: string) => partials.get(requestId),
    scheduleRetry: vi.fn(async () => {}),
    scheduleContinuation: vi.fn(async () => {}),
    terminalize: vi.fn(async () => {}),
    setLastRequestId(id) {
      last = id;
    },
    setPartial(requestId, message) {
      if (message) partials.set(requestId, message);
      else partials.delete(requestId);
    },
  };
}

interface Harness {
  store: KeyValueStore;
  clock: TestClock;
  events: ObservabilityEvent[];
  fibers: FiberService;
  conversation: ConversationFake;
  recovery: ChatRecovery;
  ids: IdSource;
}

function harness(policy?: RecoveryPolicy): Harness {
  const store = createMemoryKeyValueStore();
  const clock = createTestClock(0);
  const alarm = createMemoryAlarmTimer(clock);
  const events: ObservabilityEvent[] = [];
  const bus = createEventBus({ agent: "test", name: "agent-1" }, () => clock.now());
  bus.subscribe("*", (e) => events.push(e));
  const ids = counterIds();

  const scheduler = createScheduler({
    store,
    alarm,
    clock,
    ids,
    bus,
    dispatch: async () => {},
  });
  alarm.onAlarm(() => scheduler.onAlarm());
  const keepAlive = createKeepAlive(scheduler);

  const fibers = createFiberService({
    store,
    clock,
    ids,
    bus,
    keepAlive,
    scheduler,
    onRecovered: async (ctx) => recovery.onFiberRecovered(ctx),
  });

  const conversation = conversationFake();

  const recovery: ChatRecovery = createChatRecovery({
    store,
    fibers,
    clock,
    ids,
    bus,
    ...(policy !== undefined ? { policy } : {}),
    conversation,
  });

  return { store, clock, events, fibers, conversation, recovery, ids };
}

function completedOutcome(): TurnOutcome {
  return { kind: "completed", steps: [], finishReason: "stop" };
}

function erroredOutcome(): TurnOutcome {
  return { kind: "error", error: new Error("boom"), steps: [] };
}

describe("createChatRecovery", () => {
  describe("runRecoverable", () => {
    it("runs the execute callback inside a chat-turn fiber and returns its outcome", async () => {
      const h = harness();
      h.conversation.setLastRequestId("req-1");
      let sawSignal = false;
      const outcome = await h.recovery.runRecoverable({
        requestId: "req-1",
        input: { requestId: "req-1", messages: [] },
        execute: async (signal) => {
          sawSignal = signal instanceof AbortSignal;
          return completedOutcome();
        },
      });
      expect(sawSignal).toBe(true);
      expect(outcome).toEqual(completedOutcome());
    });

    it("propagates a throw from execute", async () => {
      const h = harness();
      await expect(
        h.recovery.runRecoverable({
          requestId: "req-1",
          input: { requestId: "req-1" },
          execute: async () => {
            throw new Error("kaput");
          },
        }),
      ).rejects.toThrow("kaput");
    });
  });

  describe("onFiberRecovered: no assistant output -> retry", () => {
    it("schedules a retry with the original input, kind 'retry'", async () => {
      const h = harness();
      h.conversation.setLastRequestId("req-1");

      const runPromise = h.recovery.runRecoverable({
        requestId: "req-1",
        input: { requestId: "req-1", messages: [], trigger: "chat" },
        execute: () => new Promise<TurnOutcome>(() => {}), // hangs forever (simulated eviction)
      });
      void runPromise.catch(() => {});

      // Simulate eviction: a fresh service instance recovering the orphaned row.
      const h2 = harness();
      // Reuse the same store/conversation state by copying keys manually isn't
      // straightforward across two independently-wired harnesses, so instead
      // drive the scenario through fibers.checkInterrupted on the SAME wiring.
      await h.fibers.checkInterrupted(); // no-op: fiber is live in this process

      // Directly exercise onFiberRecovered with a synthetic interrupted ctx,
      // as fibers.ts would build it from an orphaned run row.
      const result = await h.recovery.onFiberRecovered({
        fiberId: "fiber_1",
        name: "chat-turn",
        snapshot: { requestId: "req-1", attempt: 1, phase: "running" },
        metadata: null,
        createdAt: 0,
        recoveryReason: "interrupted",
      });

      expect(result).toBeUndefined();
      expect(h.conversation.scheduleRetry).toHaveBeenCalledTimes(1);
      const [input, incident] = h.conversation.scheduleRetry.mock.calls[0]! as [unknown, Incident];
      expect(input).toMatchObject({ requestId: "req-1", trigger: "chat" });
      expect(incident).toMatchObject({ requestId: "req-1", attempt: 1, recoveryKind: "retry" });
      expect(h.conversation.scheduleContinuation).not.toHaveBeenCalled();

      expect(h.events.some((e) => e.type === "chat:recovery:detected")).toBe(true);
      expect(h.events.some((e) => e.type === "chat:recovery:scheduled")).toBe(true);
      void h2; // unused placeholder harness (kept out of assertions)
    });
  });

  describe("onFiberRecovered: partial persisted -> continue", () => {
    it("schedules a continuation, kind 'continue'", async () => {
      const h = harness();
      h.conversation.setLastRequestId("req-1");
      h.conversation.setPartial("req-1", assistantMessage([{ type: "text", text: "partial..." }]));

      await h.recovery.onFiberRecovered({
        fiberId: "fiber_1",
        name: "chat-turn",
        snapshot: { requestId: "req-1", attempt: 1, phase: "running" },
        metadata: null,
        createdAt: 0,
        recoveryReason: "interrupted",
      });

      expect(h.conversation.scheduleContinuation).toHaveBeenCalledTimes(1);
      const [incident] = h.conversation.scheduleContinuation.mock.calls[0]! as [Incident];
      expect(incident).toMatchObject({ requestId: "req-1", attempt: 1, recoveryKind: "continue" });
      expect(h.conversation.scheduleRetry).not.toHaveBeenCalled();
    });

    it("attempt increments across two interruptions", async () => {
      const h = harness();
      h.conversation.setLastRequestId("req-1");
      h.conversation.setPartial("req-1", assistantMessage([{ type: "text", text: "partial..." }]));

      const ctx = {
        fiberId: "fiber_1",
        name: "chat-turn",
        snapshot: { requestId: "req-1", attempt: 1, phase: "running" },
        metadata: null,
        createdAt: 0,
        recoveryReason: "interrupted" as const,
      };
      await h.recovery.onFiberRecovered(ctx);
      await h.recovery.onFiberRecovered(ctx);

      expect(h.conversation.scheduleContinuation).toHaveBeenCalledTimes(2);
      const first = h.conversation.scheduleContinuation.mock.calls[0]![0] as Incident;
      const second = h.conversation.scheduleContinuation.mock.calls[1]![0] as Incident;
      expect(first.attempt).toBe(1);
      expect(second.attempt).toBe(2);
      expect(second.incidentId).toBe(first.incidentId);
    });

    it("exhausts at maxAttempts: terminal message, event, onExhausted", async () => {
      const onExhausted = vi.fn(async (_incident: Incident) => {});
      const h = harness({ maxAttempts: 2, terminalMessage: "Give up now.", onExhausted });
      h.conversation.setLastRequestId("req-1");
      h.conversation.setPartial("req-1", assistantMessage([{ type: "text", text: "partial..." }]));

      const ctx = {
        fiberId: "fiber_1",
        name: "chat-turn",
        snapshot: { requestId: "req-1", attempt: 1, phase: "running" },
        metadata: null,
        createdAt: 0,
        recoveryReason: "interrupted" as const,
      };
      await h.recovery.onFiberRecovered(ctx); // attempt 1 -> scheduled
      await h.recovery.onFiberRecovered(ctx); // attempt 2 -> scheduled
      await h.recovery.onFiberRecovered(ctx); // attempt 3 > maxAttempts(2) -> exhausted

      expect(h.conversation.terminalize).toHaveBeenCalledTimes(1);
      const [incident, message] = h.conversation.terminalize.mock.calls[0]! as [Incident, string];
      expect(message).toBe("Give up now.");
      expect(incident.requestId).toBe("req-1");
      expect(onExhausted).toHaveBeenCalledTimes(1);
      expect(onExhausted.mock.calls[0]![0]).toMatchObject({ requestId: "req-1" });
      expect(h.events.some((e) => e.type === "chat:recovery:exhausted")).toBe(true);
      expect(h.recovery.isRecovering()).toBe(false);
    });
  });

  describe("onFiberRecovered: conversation changed -> skipped", () => {
    it("emits skipped with a reason and does not schedule anything", async () => {
      const h = harness();
      h.conversation.setLastRequestId("some-other-request");

      const result = await h.recovery.onFiberRecovered({
        fiberId: "fiber_1",
        name: "chat-turn",
        snapshot: { requestId: "req-1", attempt: 1, phase: "running" },
        metadata: null,
        createdAt: 0,
        recoveryReason: "interrupted",
      });

      expect(result).toBeUndefined();
      expect(h.conversation.scheduleRetry).not.toHaveBeenCalled();
      expect(h.conversation.scheduleContinuation).not.toHaveBeenCalled();
      const skipped = h.events.find((e) => e.type === "chat:recovery:skipped");
      expect(skipped).toBeDefined();
      expect(skipped!.payload).toMatchObject({ requestId: "req-1" });
      expect(typeof skipped!.payload.reason).toBe("string");
    });

    it("ignores fiber-recovery contexts for other fiber names", async () => {
      const h = harness();
      h.conversation.setLastRequestId("req-1");
      const result = await h.recovery.onFiberRecovered({
        fiberId: "fiber_1",
        name: "some-other-fiber",
        snapshot: { requestId: "req-1", attempt: 1 },
        metadata: null,
        createdAt: 0,
        recoveryReason: "interrupted",
      });
      expect(result).toBeUndefined();
      expect(h.conversation.scheduleRetry).not.toHaveBeenCalled();
      expect(h.events.some((e) => e.type.startsWith("chat:recovery"))).toBe(false);
    });
  });

  describe("handleStall", () => {
    it("routes into the continuation path and returns 'recovering'", async () => {
      const h = harness();
      h.conversation.setLastRequestId("req-1");
      h.conversation.setPartial("req-1", assistantMessage([{ type: "text", text: "partial..." }]));

      const result = await h.recovery.handleStall("req-1");
      expect(result).toBe("recovering");
      expect(h.conversation.scheduleContinuation).toHaveBeenCalledTimes(1);
      const incident = h.conversation.scheduleContinuation.mock.calls[0]![0] as Incident;
      expect(incident.recoveryKind).toBe("continue");
    });

    it("returns 'terminal' once attempts are exhausted", async () => {
      const h = harness({ maxAttempts: 1 });
      h.conversation.setLastRequestId("req-1");
      h.conversation.setPartial("req-1", assistantMessage([{ type: "text", text: "partial..." }]));

      const first = await h.recovery.handleStall("req-1");
      expect(first).toBe("recovering");
      const second = await h.recovery.handleStall("req-1");
      expect(second).toBe("terminal");
      expect(h.conversation.terminalize).toHaveBeenCalledTimes(1);
    });
  });

  describe("isRecovering", () => {
    it("is true between scheduled and terminal, cleared on completion", async () => {
      const h = harness();
      h.conversation.setLastRequestId("req-1");
      expect(h.recovery.isRecovering()).toBe(false);

      await h.recovery.onFiberRecovered({
        fiberId: "fiber_1",
        name: "chat-turn",
        snapshot: { requestId: "req-1", attempt: 1, phase: "running" },
        metadata: null,
        createdAt: 0,
        recoveryReason: "interrupted",
      });
      expect(h.recovery.isRecovering()).toBe(true);

      const outcome = await h.recovery.runRecoverable({
        requestId: "req-1",
        input: { requestId: "req-1" },
        execute: async () => completedOutcome(),
      });
      expect(outcome.kind).toBe("completed");
      expect(h.recovery.isRecovering()).toBe(false);
      expect(h.events.some((e) => e.type === "chat:recovery:completed")).toBe(true);
    });

    it("emits chat:recovery:attempt when a scheduled retry actually runs", async () => {
      const h = harness();
      h.conversation.setLastRequestId("req-1");
      await h.recovery.onFiberRecovered({
        fiberId: "fiber_1",
        name: "chat-turn",
        snapshot: { requestId: "req-1", attempt: 1, phase: "running" },
        metadata: null,
        createdAt: 0,
        recoveryReason: "interrupted",
      });

      const before = h.events.length;
      await h.recovery.runRecoverable({
        requestId: "req-1",
        input: { requestId: "req-1" },
        execute: async () => completedOutcome(),
      });
      const after = h.events.slice(before);
      expect(after.some((e) => e.type === "chat:recovery:attempt")).toBe(true);
      expect(after.some((e) => e.type === "chat:recovery:completed")).toBe(true);
    });

    it("stays recovering when a scheduled retry errors without completing", async () => {
      const h = harness();
      h.conversation.setLastRequestId("req-1");
      await h.recovery.onFiberRecovered({
        fiberId: "fiber_1",
        name: "chat-turn",
        snapshot: { requestId: "req-1", attempt: 1, phase: "running" },
        metadata: null,
        createdAt: 0,
        recoveryReason: "interrupted",
      });
      expect(h.recovery.isRecovering()).toBe(true);

      const outcome = await h.recovery.runRecoverable({
        requestId: "req-1",
        input: { requestId: "req-1" },
        execute: async () => erroredOutcome(),
      });
      expect(outcome.kind).toBe("error");
      expect(h.recovery.isRecovering()).toBe(true);
    });
  });
});
