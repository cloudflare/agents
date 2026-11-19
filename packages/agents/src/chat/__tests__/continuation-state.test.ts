import { describe, it, expect, vi } from "vitest";
import {
  ContinuationState,
  continuationTargetIsLatest
} from "../continuation-state";
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
      targetMessageIds: ["assistant-1"],
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
      targetMessageIds: ["assistant-1"],
      prerequisite: null,
      pastCoalesce: false
    };
    state.deferred = {
      connection: conn,
      connectionId: "c1",
      errorPrefix: "[test]",
      targetMessageIds: ["assistant-1"],
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
      targetMessageIds: ["assistant-1"],
      prerequisite: null
    };
    state.pending = {
      connection: conn,
      connectionId: "c1",
      requestId: "r1",
      errorPrefix: null,
      targetMessageIds: ["assistant-1"],
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
      targetMessageIds: ["assistant-1"],
      prerequisite: null,
      pastCoalesce: false
    };
    state.deferred = {
      connection: conn,
      connectionId: "c1",
      errorPrefix: "[test]",
      targetMessageIds: ["assistant-1"],
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

  // ── releaseConnection ─────────────────────────────────────────────

  it("releaseConnection clears ownership without removing pending", () => {
    const state = new ContinuationState();
    const conn = makeConnection("c1");
    state.pending = {
      connection: conn,
      connectionId: "c1",
      requestId: "r1",
      errorPrefix: null,
      targetMessageIds: ["assistant-1"],
      prerequisite: null,
      pastCoalesce: false
    };
    state.awaitingConnections.set("c1", conn);

    state.releaseConnection("c1");

    expect(state.pending).not.toBeNull();
    expect(state.pending!.connection).toBe(conn);
    expect(state.pending!.connectionId).toBeNull();
    expect(state.awaitingConnections.size).toBe(0);
  });

  it("releaseConnection clears deferred and active ownership", () => {
    const state = new ContinuationState();
    const conn = makeConnection("c1");
    state.deferred = {
      connection: conn,
      connectionId: "c1",
      errorPrefix: "[test]",
      targetMessageIds: ["assistant-1"],
      prerequisite: null
    };
    state.activeRequestId = "r1";
    state.activeConnectionId = "c1";

    state.releaseConnection("c1");

    expect(state.deferred).not.toBeNull();
    expect(state.deferred!.connectionId).toBeNull();
    expect(state.activeRequestId).toBe("r1");
    expect(state.activeConnectionId).toBeNull();
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
      targetMessageIds: ["assistant-1"],
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
      errorPrefix: "[test]",
      targetMessageIds: ["assistant-1"],
      prerequisite: null
    };
    state.activeRequestId = "old-active";
    state.activeConnectionId = "old-conn";

    const result = state.activateDeferred(() => "new-req-id");

    expect(result).not.toBeNull();
    expect(result!.requestId).toBe("new-req-id");
    expect(result!.connection).toBe(conn);
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
      targetMessageIds: ["assistant-1"],
      prerequisite: null,
      pastCoalesce: false
    };
    state.deferred = {
      connection: conn,
      connectionId: "c1",
      errorPrefix: "[test]",
      targetMessageIds: ["assistant-1"],
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
      targetMessageIds: ["assistant-1"],
      prerequisite: prereq
    };

    const result = state.activateDeferred(() => "id");

    expect(result!.prerequisite).toBe(prereq);
  });
});

describe("continuationTargetIsLatest", () => {
  const messages = [{ id: "user-1" }, { id: "assistant-1" }];

  it("is true while the target message is the last message", () => {
    expect(
      continuationTargetIsLatest(messages, {
        targetMessageIds: ["assistant-1"]
      })
    ).toBe(true);
  });

  it("is false once a newer message follows the target, or the target is gone", () => {
    expect(
      continuationTargetIsLatest([...messages, { id: "user-2" }], {
        targetMessageIds: ["assistant-1"]
      })
    ).toBe(false);
    expect(
      continuationTargetIsLatest([], { targetMessageIds: ["assistant-1"] })
    ).toBe(false);
  });

  it("is true while any of several targets is the last message", () => {
    expect(
      continuationTargetIsLatest(messages, {
        targetMessageIds: ["assistant-2", "assistant-1"]
      })
    ).toBe(true);
  });

  describe("messages after the target", () => {
    const user1 = { id: "user-1", role: "user" };
    const reply = { id: "assistant-1", role: "assistant" };
    const note = { id: "note-1", role: "assistant" };
    const pending = { targetMessageIds: ["assistant-1"] };

    it("is true when only a message appended without a turn follows the target", () => {
      // The reply with the tool call is the last reply a turn stored. The
      // note after it came from no turn.
      expect(
        continuationTargetIsLatest([user1, reply, note], pending, "assistant-1")
      ).toBe(true);
    });

    it("is true when several appended messages follow the target", () => {
      expect(
        continuationTargetIsLatest(
          [user1, reply, note, { id: "note-2", role: "system" }],
          pending,
          "assistant-1"
        )
      ).toBe(true);
    });

    it("is false when a newer question follows the target", () => {
      expect(
        continuationTargetIsLatest(
          [user1, reply, note, { id: "user-2", role: "user" }],
          pending,
          "assistant-1"
        )
      ).toBe(false);
    });

    it("is false when a later turn stored a reply after the target, with no question between", () => {
      // The second question was stored before the first reply, so no user
      // message separates the two replies.
      expect(
        continuationTargetIsLatest(
          [
            user1,
            { id: "user-2", role: "user" },
            reply,
            { id: "assistant-2", role: "assistant" }
          ],
          pending,
          "assistant-2"
        )
      ).toBe(false);
    });

    it("is false when the host has no record of the last turn reply", () => {
      expect(continuationTargetIsLatest([user1, reply, note], pending)).toBe(
        false
      );
      expect(
        continuationTargetIsLatest([user1, reply, note], pending, null)
      ).toBe(false);
    });

    it("is false when the recorded turn reply is no longer stored", () => {
      expect(
        continuationTargetIsLatest([user1, reply, note], pending, "gone")
      ).toBe(false);
    });

    it("uses the latest stored target of several", () => {
      expect(
        continuationTargetIsLatest(
          [user1, { id: "assistant-0", role: "assistant" }, reply, note],
          { targetMessageIds: ["assistant-0", "assistant-1"] },
          "assistant-1"
        )
      ).toBe(true);
    });
  });
});
