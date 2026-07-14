import { describe, expect, it } from "vitest";
import { createMemoryKeyValueStore } from "../../adapters/memory/store.js";
import { createTestClock } from "../../adapters/memory/clock.js";
import { createConversationEventLog, type ConversationEventLog } from "./log.js";
import { relayTurn, type RelayCallback } from "./relay.js";

function setup(): ConversationEventLog {
  return createConversationEventLog({ store: createMemoryKeyValueStore(), clock: createTestClock(0) });
}

function recordingCallback(): RelayCallback & {
  starts: Array<{ requestId: string }>;
  events: unknown[];
  dones: number;
  errors: unknown[];
  interruptions: number;
} {
  const starts: Array<{ requestId: string }> = [];
  const events: unknown[] = [];
  const errors: unknown[] = [];
  let dones = 0;
  let interruptions = 0;
  return {
    starts,
    events,
    errors,
    get dones() {
      return dones;
    },
    get interruptions() {
      return interruptions;
    },
    onStart(info) {
      starts.push(info);
    },
    onEvent(json) {
      events.push(json);
    },
    onDone() {
      dones += 1;
    },
    onError(err) {
      errors.push(err);
    },
    onInterrupted() {
      interruptions += 1;
    },
  };
}

describe("relayTurn", () => {
  it("maps turn:started -> onStart, chunk -> onEvent, and turn:settled(completed) -> onDone", () => {
    const log = setup();
    const cb = recordingCallback();
    relayTurn(log, "req_1", cb);

    log.publish({ type: "turn:started", requestId: "req_1", trigger: "chat" });
    log.publish({ type: "chunk", requestId: "req_1", chunk: { type: "text-delta", delta: "hi" } });
    log.publish({ type: "turn:settled", requestId: "req_1", outcome: "completed" });

    expect(cb.starts).toEqual([{ requestId: "req_1" }]);
    expect(cb.events).toEqual([{ type: "text-delta", delta: "hi" }]);
    expect(cb.dones).toBe(1);
    expect(cb.errors).toEqual([]);
  });

  it("maps a failed turn:settled -> onError with the error text", () => {
    const log = setup();
    const cb = recordingCallback();
    relayTurn(log, "req_1", cb);

    log.publish({ type: "turn:settled", requestId: "req_1", outcome: "failed", errorText: "boom" });

    expect(cb.errors).toEqual(["boom"]);
    expect(cb.dones).toBe(0);
  });

  it("maps a cancelled turn:settled -> onError, falling back to the outcome name with no errorText", () => {
    const log = setup();
    const cb = recordingCallback();
    relayTurn(log, "req_1", cb);

    log.publish({ type: "turn:settled", requestId: "req_1", outcome: "cancelled" });

    expect(cb.errors).toEqual(["cancelled"]);
  });

  it("maps a suspended turn:settled -> onDone (not onError)", () => {
    const log = setup();
    const cb = recordingCallback();
    relayTurn(log, "req_1", cb);

    log.publish({ type: "turn:settled", requestId: "req_1", outcome: "suspended", suspendedOn: "client-tool" });

    expect(cb.dones).toBe(1);
    expect(cb.errors).toEqual([]);
  });

  it("maps recovering:changed(active) -> onInterrupted, and (inactive) is not forwarded", () => {
    const log = setup();
    const cb = recordingCallback();
    relayTurn(log, "req_1", cb);

    log.publish({ type: "recovering:changed", requestId: "req_1", active: true });
    log.publish({ type: "recovering:changed", requestId: "req_1", active: false });

    expect(cb.interruptions).toBe(1);
  });

  it("ignores events for other requestIds", () => {
    const log = setup();
    const cb = recordingCallback();
    relayTurn(log, "req_1", cb);

    log.publish({ type: "turn:started", requestId: "req_other", trigger: "chat" });
    log.publish({ type: "chunk", requestId: "req_other", chunk: { type: "text-delta", delta: "nope" } });
    log.publish({ type: "turn:settled", requestId: "req_other", outcome: "completed" });

    expect(cb.starts).toEqual([]);
    expect(cb.events).toEqual([]);
    expect(cb.dones).toBe(0);
  });

  it("unsubscribes itself once the turn settles: later events for the same requestId are not delivered", () => {
    const log = setup();
    const cb = recordingCallback();
    relayTurn(log, "req_1", cb);

    log.publish({ type: "turn:settled", requestId: "req_1", outcome: "completed" });
    log.publish({ type: "chunk", requestId: "req_1", chunk: { type: "text-delta", delta: "late" } });

    expect(cb.dones).toBe(1);
    expect(cb.events).toEqual([]);
  });

  it("the returned unsubscribe function is a safety net: it stops delivery even before settlement", () => {
    const log = setup();
    const cb = recordingCallback();
    const unsubscribe = relayTurn(log, "req_1", cb);

    unsubscribe();
    log.publish({ type: "turn:started", requestId: "req_1", trigger: "chat" });

    expect(cb.starts).toEqual([]);
  });

  it("defaults to fromOffset 'live': events published before the subscription are not replayed", () => {
    const log = setup();
    log.publish({ type: "turn:started", requestId: "req_1", trigger: "chat" });
    const cb = recordingCallback();

    relayTurn(log, "req_1", cb);

    expect(cb.starts).toEqual([]);
  });

  it("an explicit numeric fromOffset replays events already published for the turn", () => {
    const log = setup();
    const started = log.publish({ type: "turn:started", requestId: "req_1", trigger: "chat" });
    log.publish({ type: "chunk", requestId: "req_1", chunk: { type: "text-delta", delta: "hi" } });
    const cb = recordingCallback();

    relayTurn(log, "req_1", cb, started.offset);

    expect(cb.starts).toEqual([{ requestId: "req_1" }]);
    expect(cb.events).toEqual([{ type: "text-delta", delta: "hi" }]);
  });

  it("onInterrupted is optional: a callback without it does not throw on recovering:changed(active)", () => {
    const log = setup();
    const events: unknown[] = [];
    const minimal: RelayCallback = {
      onStart: () => {},
      onEvent: (json) => events.push(json),
      onDone: () => {},
      onError: () => {},
    };

    expect(() => {
      relayTurn(log, "req_1", minimal);
      log.publish({ type: "recovering:changed", requestId: "req_1", active: true });
    }).not.toThrow();
  });

  it("a throwing callback does not prevent the subscription from later delivering turn:settled", () => {
    const log = setup();
    const errors: unknown[] = [];
    const flaky: RelayCallback = {
      onStart: () => {
        throw new Error("boom in onStart");
      },
      onEvent: () => {},
      onDone: () => {},
      onError: (err) => errors.push(err),
    };

    relayTurn(log, "req_1", flaky);
    log.publish({ type: "turn:started", requestId: "req_1", trigger: "chat" });
    log.publish({ type: "turn:settled", requestId: "req_1", outcome: "failed", errorText: "x" });

    expect(errors).toEqual(["x"]);
  });
});
