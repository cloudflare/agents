import { describe, it, expect, vi } from "vitest";
import { PreStreamTurns } from "../pre-stream-turns";
import type { ChatConnection } from "../connection";

type SentFrame = Record<string, unknown>;

function makeConnection(
  id: string,
  sink?: SentFrame[]
): ChatConnection & { send: ReturnType<typeof vi.fn> } {
  return {
    id,
    send: vi.fn((message: string) => {
      sink?.push(JSON.parse(message) as SentFrame);
    })
  };
}

describe("PreStreamTurns (#1784)", () => {
  it("starts idle: nothing in flight, park is a no-op that sends no frame", () => {
    const pre = new PreStreamTurns();
    expect(pre.hasInFlight()).toBe(false);

    const conn = makeConnection("c1");
    expect(pre.park(conn)).toBe(false);
    expect(conn.send).not.toHaveBeenCalled();
    expect(pre.awaitingConnections.size).toBe(0);
  });

  it("begin marks in flight and exposes the latest request id", () => {
    const pre = new PreStreamTurns();
    pre.begin("req-1");
    expect(pre.hasInFlight()).toBe(true);
    expect(pre.latestRequestId).toBe("req-1");
  });

  it("park enrolls a connection and sends STREAM_PENDING with the request id", () => {
    const frames: SentFrame[] = [];
    const pre = new PreStreamTurns();
    pre.begin("req-1");

    const conn = makeConnection("c1", frames);
    expect(pre.park(conn)).toBe(true);
    expect(pre.awaitingConnections.get("c1")).toBe(conn);
    expect(frames).toEqual([{ type: "cf_agent_stream_pending", id: "req-1" }]);
  });

  it("flushOnStreamStart notifies each parked connection then clears the map (keeps accepted)", () => {
    const pre = new PreStreamTurns();
    pre.begin("req-1");
    const c1 = makeConnection("c1");
    const c2 = makeConnection("c2");
    pre.park(c1);
    pre.park(c2);

    const notified: string[] = [];
    pre.flushOnStreamStart((c) => notified.push(c.id));

    expect(notified.sort()).toEqual(["c1", "c2"]);
    expect(pre.awaitingConnections.size).toBe(0);
    // The turn is still running until settle() — accepted set untouched.
    expect(pre.hasInFlight()).toBe(true);
  });

  it("releaseAwaiting sends STREAM_RESUME_NONE to each parked connection then clears", () => {
    const frames: SentFrame[] = [];
    const pre = new PreStreamTurns();
    pre.begin("req-1");
    const c1 = makeConnection("c1", frames);
    pre.park(c1);
    frames.length = 0;

    pre.releaseAwaiting();

    expect(frames).toEqual([{ type: "cf_agent_stream_resume_none" }]);
    expect(pre.awaitingConnections.size).toBe(0);
  });

  it("settle returns true only when the last accepted turn settles", () => {
    const pre = new PreStreamTurns();
    pre.begin("a");
    pre.begin("b");

    expect(pre.settle("a")).toBe(false);
    expect(pre.hasInFlight()).toBe(true);
    expect(pre.settle("b")).toBe(true);
    expect(pre.hasInFlight()).toBe(false);
    expect(pre.latestRequestId).toBeNull();
  });

  it("settling an unknown id is safe and reports idle when nothing else is in flight", () => {
    const pre = new PreStreamTurns();
    expect(pre.settle("never-began")).toBe(true);
  });

  it("a connection parked during the gap between queued turns survives the first turn's settle", () => {
    // A begins, streams, settles while B is still queued (begin'd). A reconnect
    // that parked must NOT be released until B also settles with no stream.
    const pre = new PreStreamTurns();
    pre.begin("a");
    pre.begin("b");
    const conn = makeConnection("c1");
    pre.park(conn);

    // A finishes first: not idle (B still in flight) → caller would NOT release.
    expect(pre.settle("a")).toBe(false);
    expect(pre.awaitingConnections.get("c1")).toBe(conn);

    // B finishes: now idle.
    expect(pre.settle("b")).toBe(true);
  });

  it("models the skip-path contract: settle WITHOUT releaseAwaiting keeps a parked client for the successor (#1784)", () => {
    // Mirrors the host `_completeSkippedRequest` flow: a superseded turn settles
    // out of the accepted set but must NOT release parked connections, so a
    // client parked during the pre-stream window survives onto the turn that
    // actually streams — even if the set momentarily empties before the
    // successor's `begin()` runs (the supersede/settle microtask race).
    const pre = new PreStreamTurns();
    pre.begin("superseded");
    const conn = makeConnection("c1");
    pre.park(conn);

    // The superseded turn settles. The host does NOT call releaseAwaiting here.
    expect(pre.settle("superseded")).toBe(true); // set momentarily empty
    expect(pre.awaitingConnections.get("c1")).toBe(conn); // still parked

    // The successor turn begins and starts streaming → the parked client is
    // flushed into the normal resume handshake rather than stranded.
    pre.begin("successor");
    const notified: string[] = [];
    pre.flushOnStreamStart((c) => notified.push(c.id));
    expect(notified).toEqual(["c1"]);
    expect(pre.awaitingConnections.size).toBe(0);
  });

  it("release drops a single connection without touching the rest", () => {
    const pre = new PreStreamTurns();
    pre.begin("req-1");
    const c1 = makeConnection("c1");
    const c2 = makeConnection("c2");
    pre.park(c1);
    pre.park(c2);

    pre.release("c1");

    expect(pre.awaitingConnections.has("c1")).toBe(false);
    expect(pre.awaitingConnections.get("c2")).toBe(c2);
  });

  it("park without a known request id omits the id from the keep-waiting frame", () => {
    const frames: SentFrame[] = [];
    const pre = new PreStreamTurns();
    // settle the only id so latestRequestId is null but force in-flight via a
    // second begin with an empty-ish id path: emulate by beginning then parking.
    pre.begin("");
    const conn = makeConnection("c1", frames);
    pre.park(conn);
    expect(frames).toEqual([{ type: "cf_agent_stream_pending" }]);
  });

  it("reset drops all state and sends no frames", () => {
    const pre = new PreStreamTurns();
    pre.begin("req-1");
    const c1 = makeConnection("c1");
    pre.park(c1);
    c1.send.mockClear();

    pre.reset();

    expect(pre.hasInFlight()).toBe(false);
    expect(pre.awaitingConnections.size).toBe(0);
    expect(pre.latestRequestId).toBeNull();
    expect(c1.send).not.toHaveBeenCalled();
  });
});
