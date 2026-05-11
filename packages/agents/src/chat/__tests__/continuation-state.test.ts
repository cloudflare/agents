import { describe, it, expect, vi } from "vitest";
import { ContinuationState } from "../continuation-state";
import type { ContinuationConnection } from "../continuation-state";

function makeConnection(id: string): ContinuationConnection {
  return { id, send: vi.fn() };
}

describe("ContinuationState", () => {
  // ── clearPending ──────────────────────────────────────────────────

  it("clearPending nulls pending and clears awaitingConnections", () => {
    const state = new ContinuationState();
    const conn = makeConnection("c1");
    state.pending = {
      connection: conn,
      connectionId: "c1",
      requestId: "r1",
      errorPrefix: null,
      prerequisite: null,
      pastCoalesce: false
    };
    state.awaitingConnections.set("c1", conn);

    state.clearPending();

    expect(state.pending).toBeNull();
    expect(state.awaitingConnections.size).toBe(0);
  });

  it("clearPending does not affect deferred or active", () => {
    const state = new ContinuationState();
    const conn = makeConnection("c1");
    state.pending = {
      connection: conn,
      connectionId: "c1",
      requestId: "r1",
      errorPrefix: null,
      prerequisite: null,
      pastCoalesce: false
    };
    state.deferred = {
      connection: conn,
      connectionId: "c1",
      errorPrefix: "[test]",
      prerequisite: null
    };
    state.activeRequestId = "ar1";
    state.activeConnectionId = "ac1";

    state.clearPending();

    expect(state.deferred).not.toBeNull();
    expect(state.activeRequestId).toBe("ar1");
    expect(state.activeConnectionId).toBe("ac1");
  });

  // ── clearDeferred ─────────────────────────────────────────────────

  it("clearDeferred nulls deferred only", () => {
    const state = new ContinuationState();
    const conn = makeConnection("c1");
    state.deferred = {
      connection: conn,
      connectionId: "c1",
      errorPrefix: "[test]",
      prerequisite: null
    };
    state.pending = {
      connection: conn,
      connectionId: "c1",
      requestId: "r1",
      errorPrefix: null,
      prerequisite: null,
      pastCoalesce: false
    };

    state.clearDeferred();

    expect(state.deferred).toBeNull();
    expect(state.pending).not.toBeNull();
  });

  // ── clearAll ──────────────────────────────────────────────────────

  it("clearAll resets everything", () => {
    const state = new ContinuationState();
    const conn = makeConnection("c1");
    state.pending = {
      connection: conn,
      connectionId: "c1",
      requestId: "r1",
      errorPrefix: null,
      prerequisite: null,
      pastCoalesce: false
    };
    state.deferred = {
      connection: conn,
      connectionId: "c1",
      errorPrefix: "[test]",
      prerequisite: null
    };
    state.activeRequestId = "ar1";
    state.activeConnectionId = "ac1";
    state.awaitingConnections.set("c1", conn);

    state.clearAll();

    expect(state.pending).toBeNull();
    expect(state.deferred).toBeNull();
    expect(state.activeRequestId).toBeNull();
    expect(state.activeConnectionId).toBeNull();
    expect(state.awaitingConnections.size).toBe(0);
  });

  // ── sendResumeNone ────────────────────────────────────────────────

  it("sendResumeNone sends to all awaiting connections then clears", () => {
    const state = new ContinuationState();
    const conn1 = makeConnection("c1");
    const conn2 = makeConnection("c2");
    state.awaitingConnections.set("c1", conn1);
    state.awaitingConnections.set("c2", conn2);

    state.sendResumeNone();

    const expected = JSON.stringify({
      type: "cf_agent_stream_resume_none"
    });
    expect(conn1.send).toHaveBeenCalledWith(expected);
    expect(conn2.send).toHaveBeenCalledWith(expected);
    expect(state.awaitingConnections.size).toBe(0);
  });

  it("sendResumeNone ignores connections closed during resume negotiation", () => {
    const state = new ContinuationState();
    const conn1 = makeConnection("c1");
    const conn2: ContinuationConnection = {
      id: "c2",
      send: vi.fn(() => {
        throw new TypeError("WebSocket send() after close");
      })
    };
    state.awaitingConnections.set("c1", conn1);
    state.awaitingConnections.set("c2", conn2);

    expect(() => state.sendResumeNone()).not.toThrow();

    const expected = JSON.stringify({
      type: "cf_agent_stream_resume_none"
    });
    expect(conn1.send).toHaveBeenCalledWith(expected);
    expect(conn2.send).toHaveBeenCalledWith(expected);
    expect(state.awaitingConnections.size).toBe(0);
  });

  it("sendResumeNone rethrows non-closed WebSocket send errors", () => {
    const state = new ContinuationState();
    const conn: ContinuationConnection = {
      id: "c1",
      send: vi.fn(() => {
        throw new TypeError("unexpected send failure");
      })
    };
    state.awaitingConnections.set("c1", conn);

    expect(() => state.sendResumeNone()).toThrow("unexpected send failure");
  });

  it("sendResumeNone is a no-op when no connections are waiting", () => {
    const state = new ContinuationState();
    state.sendResumeNone();
    expect(state.awaitingConnections.size).toBe(0);
  });

  // ── flushAwaitingConnections ──────────────────────────────────────

  it("flushAwaitingConnections calls notify for each and clears", () => {
    const state = new ContinuationState();
    const conn1 = makeConnection("c1");
    const conn2 = makeConnection("c2");
    state.awaitingConnections.set("c1", conn1);
    state.awaitingConnections.set("c2", conn2);

    const notified: string[] = [];
    state.flushAwaitingConnections((c) => notified.push(c.id));

    expect(notified).toEqual(["c1", "c2"]);
    expect(state.awaitingConnections.size).toBe(0);
  });

  // ── activatePending ───────────────────────────────────────────────

  it("activatePending moves request/connection IDs to active slots", () => {
    const state = new ContinuationState();
    const conn = makeConnection("c1");
    state.pending = {
      connection: conn,
      connectionId: "c1",
      requestId: "r1",
      errorPrefix: null,
      prerequisite: null,
      pastCoalesce: false
    };

    state.activatePending();

    expect(state.activeRequestId).toBe("r1");
    expect(state.activeConnectionId).toBe("c1");
    expect(state.pending).toBeNull();
  });

  it("activatePending is a no-op when no pending", () => {
    const state = new ContinuationState();
    state.activeRequestId = "old";

    state.activatePending();

    expect(state.activeRequestId).toBe("old");
  });

  // ── activateDeferred ──────────────────────────────────────────────

  it("activateDeferred promotes deferred to pending with new requestId", () => {
    const state = new ContinuationState();
    const conn = makeConnection("c1");
    state.deferred = {
      connection: conn,
      connectionId: "c1",
      clientTools: [{ name: "tool1" }],
      body: { key: "val" },
      errorPrefix: "[test]",
      prerequisite: null
    };
    state.activeRequestId = "old-active";
    state.activeConnectionId = "old-conn";

    const result = state.activateDeferred(() => "new-req-id");

    expect(result).not.toBeNull();
    expect(result!.requestId).toBe("new-req-id");
    expect(result!.connection).toBe(conn);
    expect(result!.clientTools).toEqual([{ name: "tool1" }]);
    expect(result!.body).toEqual({ key: "val" });
    expect(result!.errorPrefix).toBe("[test]");
    expect(result!.pastCoalesce).toBe(false);

    expect(state.pending).toBe(result);
    expect(state.deferred).toBeNull();
    expect(state.activeRequestId).toBeNull();
    expect(state.activeConnectionId).toBeNull();
    expect(state.awaitingConnections.has("c1")).toBe(true);
  });

  it("activateDeferred returns null when nothing deferred", () => {
    const state = new ContinuationState();
    const result = state.activateDeferred(() => "id");
    expect(result).toBeNull();
  });

  it("activateDeferred returns null when pending already exists", () => {
    const state = new ContinuationState();
    const conn = makeConnection("c1");
    state.pending = {
      connection: conn,
      connectionId: "c1",
      requestId: "r1",
      errorPrefix: null,
      prerequisite: null,
      pastCoalesce: false
    };
    state.deferred = {
      connection: conn,
      connectionId: "c1",
      errorPrefix: "[test]",
      prerequisite: null
    };

    const result = state.activateDeferred(() => "id");

    expect(result).toBeNull();
    expect(state.deferred).not.toBeNull();
  });

  it("activateDeferred preserves prerequisite from deferred", () => {
    const state = new ContinuationState();
    const conn = makeConnection("c1");
    const prereq = Promise.resolve(true);
    state.deferred = {
      connection: conn,
      connectionId: "c1",
      errorPrefix: "[test]",
      prerequisite: prereq
    };

    const result = state.activateDeferred(() => "id");

    expect(result!.prerequisite).toBe(prereq);
  });
});
