import { describe, expect, it, vi } from "vitest";
import { createMemoryAlarmTimer } from "../../adapters/memory/alarms.js";
import { createTestClock, type TestClock } from "../../adapters/memory/clock.js";
import { createMemoryKeyValueStore } from "../../adapters/memory/store.js";
import { createEventBus, type ObservabilityEvent } from "../../kernel/events.js";
import type { IdSource } from "../../kernel/ids.js";
import type { KeyValueStore } from "../../ports/storage.js";
import { createConversationTurnState, type ConversationTurnState } from "../chat/turn-state.js";
import { createFiberService, type FiberService } from "../fibers/fibers.js";
import { createKeepAlive } from "../scheduling/keep-alive.js";
import { createScheduler } from "../scheduling/scheduler.js";
import { assistantMessage, textOf } from "../messages/model.js";
import type { ChatMessage } from "../messages/model.js";
import type { Session } from "../session/session.js";
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

/**
 * The conversation seam: a REAL ConversationTurnState over its own store,
 * a minimal in-memory session (getHistory/appendMessage are all the seam
 * touches), and spies for the two outward callbacks + publish.
 */
interface ConversationFake {
  turnState: ConversationTurnState;
  history: ChatMessage[];
  session(): Promise<Session>;
  publish: ReturnType<typeof vi.fn>;
  scheduleTurn: ReturnType<typeof vi.fn>;
  onTerminal: ReturnType<typeof vi.fn>;
}

function conversationFake(): ConversationFake {
  const history: ChatMessage[] = [];
  const turnState = createConversationTurnState({ store: createMemoryKeyValueStore() });
  const session = {
    getHistory: async () => [...history],
    appendMessage: async (m: ChatMessage) => {
      history.push(m);
    },
  } as unknown as Session;
  return {
    turnState,
    history,
    session: () => Promise.resolve(session),
    publish: vi.fn(),
    scheduleTurn: vi.fn(),
    onTerminal: vi.fn(async () => {}),
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
    conversation: {
      turnState: conversation.turnState,
      session: conversation.session,
      publish: (e) => conversation.publish(e),
      scheduleTurn: (incident) => conversation.scheduleTurn(incident),
      onTerminal: (incident, text) => conversation.onTerminal(incident, text),
    },
  });

  return { store, clock, events, fibers, conversation, recovery, ids };
}

function completedOutcome(): TurnOutcome {
  return { kind: "completed", steps: [], finishReason: "stop" };
}

function erroredOutcome(): TurnOutcome {
  return { kind: "error", error: new Error("boom"), steps: [] };
}

function interruptedCtx(requestId = "req-1") {
  return {
    fiberId: "fiber_1",
    name: "chat-turn",
    snapshot: { requestId, attempt: 1, phase: "running" },
    metadata: null,
    createdAt: 0,
    recoveryReason: "interrupted" as const,
  };
}

describe("createChatRecovery", () => {
  describe("runRecoverable", () => {
    it("runs the execute callback inside a chat-turn fiber and returns its outcome", async () => {
      const h = harness();
      h.conversation.turnState.setLastRequestId("req-1");
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
    it("schedules a recovery turn with kind 'retry' and commits nothing", async () => {
      const h = harness();
      h.conversation.turnState.setLastRequestId("req-1");

      const result = await h.recovery.onFiberRecovered(interruptedCtx());

      expect(result).toBeUndefined();
      expect(h.conversation.scheduleTurn).toHaveBeenCalledTimes(1);
      const [incident] = h.conversation.scheduleTurn.mock.calls[0]! as [Incident];
      expect(incident).toMatchObject({ requestId: "req-1", attempt: 1, recoveryKind: "retry" });
      expect(h.conversation.history).toHaveLength(0);
      expect(h.conversation.publish).not.toHaveBeenCalled();

      expect(h.events.some((e) => e.type === "chat:recovery:detected")).toBe(true);
      expect(h.events.some((e) => e.type === "chat:recovery:scheduled")).toBe(true);
    });
  });

  describe("onFiberRecovered: partial persisted -> continue", () => {
    it("commits the repaired partial to history, publishes it, then schedules kind 'continue'", async () => {
      const h = harness();
      h.conversation.turnState.setLastRequestId("req-1");
      const partial = assistantMessage([{ type: "text", text: "partial..." }], "msg-partial");
      h.conversation.turnState.recordPartial("req-1", partial);

      await h.recovery.onFiberRecovered(interruptedCtx());

      expect(h.conversation.scheduleTurn).toHaveBeenCalledTimes(1);
      const [incident] = h.conversation.scheduleTurn.mock.calls[0]! as [Incident];
      expect(incident).toMatchObject({ requestId: "req-1", attempt: 1, recoveryKind: "continue" });

      // The continue semantics live in recovery now: partial committed to
      // session history BEFORE the turn is scheduled, published, and cleared.
      expect(h.conversation.history.map((m) => m.id)).toEqual(["msg-partial"]);
      expect(h.conversation.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: "message:updated", requestId: "req-1" }),
      );
      expect(h.conversation.turnState.partialFor("req-1")).toBeUndefined();

      // Ordering: commit happened before scheduleTurn.
      const publishOrder = h.conversation.publish.mock.invocationCallOrder[0]!;
      const scheduleOrder = h.conversation.scheduleTurn.mock.invocationCallOrder[0]!;
      expect(publishOrder).toBeLessThan(scheduleOrder);
    });

    it("attempt increments across two interruptions, same incident", async () => {
      const h = harness();
      h.conversation.turnState.setLastRequestId("req-1");
      h.conversation.turnState.recordPartial("req-1", assistantMessage([{ type: "text", text: "p1" }], "m1"));

      await h.recovery.onFiberRecovered(interruptedCtx());
      // The re-run streamed a bit more before being interrupted again.
      h.conversation.turnState.recordPartial("req-1", assistantMessage([{ type: "text", text: "p2" }], "m2"));
      await h.recovery.onFiberRecovered(interruptedCtx());

      expect(h.conversation.scheduleTurn).toHaveBeenCalledTimes(2);
      const first = h.conversation.scheduleTurn.mock.calls[0]![0] as Incident;
      const second = h.conversation.scheduleTurn.mock.calls[1]![0] as Incident;
      expect(first.attempt).toBe(1);
      expect(second.attempt).toBe(2);
      expect(second.incidentId).toBe(first.incidentId);
      expect(first.recoveryKind).toBe("continue");
      expect(second.recoveryKind).toBe("continue");
      expect(h.conversation.history.map((m) => m.id)).toEqual(["m1", "m2"]);
    });

    it("exhausts at maxAttempts: terminal message persisted, event, onExhausted, onTerminal", async () => {
      const onExhausted = vi.fn(async (_incident: Incident) => {});
      const h = harness({ maxAttempts: 2, terminalMessage: "Give up now.", onExhausted });
      h.conversation.turnState.setLastRequestId("req-1");
      h.conversation.turnState.recordPartial("req-1", assistantMessage([{ type: "text", text: "partial..." }], "m1"));

      await h.recovery.onFiberRecovered(interruptedCtx()); // attempt 1 -> scheduled
      await h.recovery.onFiberRecovered(interruptedCtx()); // attempt 2 -> scheduled
      await h.recovery.onFiberRecovered(interruptedCtx()); // attempt 3 > maxAttempts(2) -> exhausted

      // Terminalization is recovery's own act now: the terminal assistant
      // message is in history, recorded as the request's partial, published.
      const last = h.conversation.history.at(-1)!;
      expect(textOf(last)).toBe("Give up now.");
      expect(h.conversation.turnState.partialFor("req-1")?.id).toBe(last.id);
      expect(h.conversation.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: "message:updated", message: expect.objectContaining({ id: last.id }) }),
      );
      expect(h.conversation.onTerminal).toHaveBeenCalledTimes(1);
      expect(h.conversation.onTerminal.mock.calls[0]![1]).toBe("Give up now.");
      expect(onExhausted).toHaveBeenCalledTimes(1);
      expect(onExhausted.mock.calls[0]![0]).toMatchObject({ requestId: "req-1" });
      expect(h.events.some((e) => e.type === "chat:recovery:exhausted")).toBe(true);
      expect(h.recovery.isRecovering()).toBe(false);
    });
  });

  describe("onFiberRecovered: conversation changed -> skipped", () => {
    it("emits skipped with a reason and does not schedule anything", async () => {
      const h = harness();
      h.conversation.turnState.setLastRequestId("some-other-request");

      const result = await h.recovery.onFiberRecovered(interruptedCtx());

      expect(result).toBeUndefined();
      expect(h.conversation.scheduleTurn).not.toHaveBeenCalled();
      expect(h.conversation.history).toHaveLength(0);
      const skipped = h.events.find((e) => e.type === "chat:recovery:skipped");
      expect(skipped).toBeDefined();
      expect(skipped!.payload).toMatchObject({ requestId: "req-1" });
      expect(typeof skipped!.payload.reason).toBe("string");
    });

    it("ignores fiber-recovery contexts for other fiber names", async () => {
      const h = harness();
      h.conversation.turnState.setLastRequestId("req-1");
      const result = await h.recovery.onFiberRecovered({
        ...interruptedCtx(),
        name: "some-other-fiber",
      });
      expect(result).toBeUndefined();
      expect(h.conversation.scheduleTurn).not.toHaveBeenCalled();
      expect(h.events.some((e) => e.type.startsWith("chat:recovery"))).toBe(false);
    });
  });

  describe("handleStall", () => {
    it("routes into the continuation path and returns 'recovering'", async () => {
      const h = harness();
      h.conversation.turnState.setLastRequestId("req-1");
      h.conversation.turnState.recordPartial("req-1", assistantMessage([{ type: "text", text: "partial..." }], "m1"));

      const result = await h.recovery.handleStall("req-1");
      expect(result).toBe("recovering");
      expect(h.conversation.scheduleTurn).toHaveBeenCalledTimes(1);
      const incident = h.conversation.scheduleTurn.mock.calls[0]![0] as Incident;
      expect(incident.recoveryKind).toBe("continue");
      expect(h.conversation.history.map((m) => m.id)).toEqual(["m1"]);
    });

    it("returns 'terminal' once attempts are exhausted", async () => {
      const h = harness({ maxAttempts: 1, terminalMessage: "Done trying." });
      h.conversation.turnState.setLastRequestId("req-1");
      h.conversation.turnState.recordPartial("req-1", assistantMessage([{ type: "text", text: "partial..." }], "m1"));

      const first = await h.recovery.handleStall("req-1");
      expect(first).toBe("recovering");
      const second = await h.recovery.handleStall("req-1");
      expect(second).toBe("terminal");
      expect(h.conversation.onTerminal).toHaveBeenCalledTimes(1);
      expect(textOf(h.conversation.history.at(-1)!)).toBe("Done trying.");
    });
  });

  describe("isRecovering", () => {
    it("is true between scheduled and terminal, cleared on completion", async () => {
      const h = harness();
      h.conversation.turnState.setLastRequestId("req-1");
      expect(h.recovery.isRecovering()).toBe(false);

      await h.recovery.onFiberRecovered(interruptedCtx());
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
      h.conversation.turnState.setLastRequestId("req-1");
      await h.recovery.onFiberRecovered(interruptedCtx());

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
      h.conversation.turnState.setLastRequestId("req-1");
      await h.recovery.onFiberRecovered(interruptedCtx());
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
