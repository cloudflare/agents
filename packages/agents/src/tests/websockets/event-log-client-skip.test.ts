import { describe, expect, it } from "vitest";
import { followEventLog } from "../../client";

/**
 * A live frame that skips seqs makes the follower re-subscribe. Until the
 * server answers, a further live frame must not move the cursor: if it did,
 * the replay that follows would drop the missing events as `seq <= cursor`.
 */
class FakeSocket extends EventTarget {
  readyState = 1;
  readonly sent: Array<Record<string, unknown>> = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  deliver(frame: Record<string, unknown>) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(frame) })
    );
  }
}

describe("followEventLog skip guard", () => {
  it("does not let a live frame jump seqs while a skip-triggered re-subscribe is in flight", () => {
    const socket = new FakeSocket();
    const applied: number[] = [];
    followEventLog(socket, "feed", {
      onEvent: (_data, seq) => applied.push(seq),
      onResync: () => {}
    });
    const id = socket.sent[0].id as string;
    socket.deliver({
      type: "cf_agent_log_resync",
      log: "feed",
      epoch: "e",
      seq: 10,
      id
    });
    // A live event that skips 11..15: the follower re-subscribes.
    socket.deliver({
      type: "cf_agent_log_events",
      log: "feed",
      events: [{ seq: 16, data: 16 }]
    });
    expect(socket.sent.at(-1)).toMatchObject({
      type: "cf_agent_log_subscribe",
      cursor: { seq: 10 }
    });
    // Another live event arrives before the server answers the subscribe.
    socket.deliver({
      type: "cf_agent_log_events",
      log: "feed",
      events: [{ seq: 17, data: 17 }]
    });
    // The server's answer to the subscribe: replay 11..17, synced.
    socket.deliver({
      type: "cf_agent_log_events",
      log: "feed",
      id,
      events: [11, 12, 13, 14, 15, 16, 17].map((seq) => ({ seq, data: seq }))
    });
    socket.deliver({
      type: "cf_agent_log_synced",
      log: "feed",
      epoch: "e",
      seq: 17,
      id
    });
    expect(applied).toEqual([11, 12, 13, 14, 15, 16, 17]);
  });
});
