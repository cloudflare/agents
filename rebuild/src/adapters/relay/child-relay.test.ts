import { describe, expect, it } from "vitest";
import type { ConversationEventLog } from "../../domain/events/log.js";
import type { RelayCallback } from "../../domain/events/relay.js";
import { relayTurn } from "./child-relay.js";
import type { Think } from "../../app/think.js";
import { createMemoryKeyValueStore } from "../memory/store.js";
import { createTestClock } from "../memory/clock.js";
import { createConversationEventLog } from "../../domain/events/log.js";

function agentWithLog(
  log: ConversationEventLog,
  activeTurn: { requestId: string; startOffset: number } | null,
): Pick<Think, "events" | "activeTurn"> {
  return {
    events: () => log,
    activeTurn: () => activeTurn,
  };
}

function recordingCallback(): RelayCallback & { starts: unknown[]; events: unknown[]; dones: number } {
  const starts: unknown[] = [];
  const events: unknown[] = [];
  let dones = 0;
  return {
    starts,
    events,
    get dones() {
      return dones;
    },
    onStart: (info) => starts.push(info),
    onEvent: (json) => events.push(json),
    onDone: () => {
      dones += 1;
    },
    onError: () => {},
  };
}

describe("adapters/relay/child-relay.ts relayTurn", () => {
  it("subscribes 'live' when the requested turn is not the agent's active turn", () => {
    const log = createConversationEventLog({ store: createMemoryKeyValueStore(), clock: createTestClock(0) });
    // Published *before* the relay attaches: with a "live" subscription this must NOT be replayed.
    log.publish({ type: "turn:started", requestId: "req_1", trigger: "chat" });

    const cb = recordingCallback();
    relayTurn(agentWithLog(log, null) as Think, "req_1", cb);

    expect(cb.starts).toEqual([]);
  });

  it("replays from the turn's startOffset when it is the agent's active turn, catching up on missed chunks", () => {
    const log = createConversationEventLog({ store: createMemoryKeyValueStore(), clock: createTestClock(0) });
    const started = log.publish({ type: "turn:started", requestId: "req_1", trigger: "chat" });
    log.publish({ type: "chunk", requestId: "req_1", chunk: { type: "start", messageId: "m1" } });

    const cb = recordingCallback();
    relayTurn(agentWithLog(log, { requestId: "req_1", startOffset: started.offset }) as Think, "req_1", cb);

    expect(cb.starts).toEqual([{ requestId: "req_1" }]);
    expect(cb.events).toEqual([{ type: "start", messageId: "m1" }]);
  });

  it("only replays when the active turn's requestId matches the one being relayed", () => {
    const log = createConversationEventLog({ store: createMemoryKeyValueStore(), clock: createTestClock(0) });
    log.publish({ type: "turn:started", requestId: "req_1", trigger: "chat" });
    log.publish({ type: "chunk", requestId: "req_1", chunk: { type: "start", messageId: "m1" } });

    const cb = recordingCallback();
    // Active turn is a *different* request: no replay for req_1.
    relayTurn(agentWithLog(log, { requestId: "req_other", startOffset: 0 }) as Think, "req_1", cb);

    expect(cb.starts).toEqual([]);
    expect(cb.events).toEqual([]);
  });

  it("continues live after catching up: a later chunk for the active turn is delivered", () => {
    const log = createConversationEventLog({ store: createMemoryKeyValueStore(), clock: createTestClock(0) });
    const started = log.publish({ type: "turn:started", requestId: "req_1", trigger: "chat" });

    const cb = recordingCallback();
    relayTurn(agentWithLog(log, { requestId: "req_1", startOffset: started.offset }) as Think, "req_1", cb);

    log.publish({ type: "chunk", requestId: "req_1", chunk: { type: "text-delta", delta: "hi" } });
    log.publish({ type: "turn:settled", requestId: "req_1", outcome: "completed" });

    expect(cb.events).toEqual([{ type: "text-delta", delta: "hi" }]);
    expect(cb.dones).toBe(1);
  });
});
