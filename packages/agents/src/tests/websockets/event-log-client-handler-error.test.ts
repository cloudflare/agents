import { describe, expect, it, vi } from "vitest";
import { followEventLog } from "../../internal";

/**
 * A throwing `onEvent` must not cost the follower the rest of the frame.
 * During a replay the follower does not check for seq gaps, so an event
 * left unapplied in one replay frame was never delivered again.
 */
class FakeSocket extends EventTarget {
  readyState = 1;
  readonly sent: Array<Record<string, unknown>> = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  /** A browser reports a listener's exception and goes on; so does this. */
  deliver(frame: Record<string, unknown>) {
    try {
      this.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(frame) })
      );
    } catch {
      // reported, as a browser would
    }
  }
}

describe("followEventLog handler errors", () => {
  it("applies every replayed event when onEvent throws for one", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const socket = new FakeSocket();
    const seen: number[] = [];
    const sub = followEventLog(socket, "feed", {
      onEvent: (_data, seq) => {
        seen.push(seq);
        if (seq === 2) throw new Error("handler bug");
      },
      onResync: () => {}
    });
    const id = socket.sent[0].id as string;
    socket.deliver({
      type: "cf_agent_log_resync",
      log: "feed",
      epoch: "e",
      seq: 0,
      id
    });
    // Reconnect: the follower re-subscribes from its cursor.
    socket.dispatchEvent(new Event("open"));
    socket.deliver({
      type: "cf_agent_log_events",
      log: "feed",
      id,
      events: [1, 2, 3].map((seq) => ({ seq, data: seq }))
    });
    socket.deliver({
      type: "cf_agent_log_events",
      log: "feed",
      id,
      events: [4, 5].map((seq) => ({ seq, data: seq }))
    });
    socket.deliver({
      type: "cf_agent_log_synced",
      log: "feed",
      epoch: "e",
      seq: 5,
      id
    });

    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(sub.cursor).toEqual({ epoch: "e", seq: 5 });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("applies the rest of a live frame when onEvent throws for one", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const socket = new FakeSocket();
    const seen: number[] = [];
    followEventLog(socket, "feed", {
      onEvent: (_data, seq) => {
        seen.push(seq);
        if (seq === 1) throw new Error("handler bug");
      },
      onResync: () => {}
    });
    const id = socket.sent[0].id as string;
    socket.deliver({
      type: "cf_agent_log_resync",
      log: "feed",
      epoch: "e",
      seq: 0,
      id
    });
    socket.deliver({
      type: "cf_agent_log_events",
      log: "feed",
      events: [1, 2].map((seq) => ({ seq, data: seq }))
    });

    expect(seen).toEqual([1, 2]);
    error.mockRestore();
  });
});
