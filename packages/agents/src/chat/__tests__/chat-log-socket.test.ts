import { describe, expect, it } from "vitest";
import { ChatLogSocket } from "../chat-log-socket";

/** A fake agent socket: records sends, lets the test deliver frames. */
class FakeAgent extends EventTarget {
  readyState = 1;
  shouldReconnect = true;
  _pk = "me";
  readonly sent: Array<Record<string, unknown>> = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
    return true;
  }
  deliver(frame: Record<string, unknown>) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(frame) })
    );
  }
  subscribeId(): string {
    const frame = this.sent.find((f) => f.type === "cf_agent_log_subscribe");
    return frame?.id as string;
  }
}

function setup() {
  const agent = new FakeAgent();
  const socket = new ChatLogSocket(agent);
  socket.retain();
  const seen: Array<Record<string, unknown>> = [];
  const events: string[] = [];
  socket.addEventListener("message", (event: Event) =>
    seen.push(JSON.parse((event as MessageEvent).data as string))
  );
  socket.addEventListener("close", () => events.push("close"));
  socket.addEventListener("open", () => events.push("open"));
  return { agent, socket, seen, events };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const RESPONSE = "cf_agent_use_chat_response";

describe("ChatLogSocket", () => {
  it("passes everything through when the server has no chat log", async () => {
    const { agent, socket, seen } = setup();
    agent.deliver({ type: "cf_agent_stream_resuming", id: "r1" });
    socket.send(JSON.stringify({ type: "cf_agent_stream_resume_request" }));
    // Before the server answers, the request goes out after the subscribe.
    expect(agent.sent.map((f) => f.type)).toEqual([
      "cf_agent_log_subscribe",
      "cf_agent_stream_resume_request"
    ]);
    agent.deliver({
      type: "cf_agent_log_error",
      log: "cf_chat",
      error: "No event log",
      id: agent.subscribeId()
    });
    socket.send(
      JSON.stringify({ type: "cf_agent_stream_resume_ack", id: "r1" })
    );
    expect(agent.sent.at(-1)).toEqual({
      type: "cf_agent_stream_resume_ack",
      id: "r1"
    });
    expect(seen).toEqual([{ type: "cf_agent_stream_resuming", id: "r1" }]);
  });

  it("rebuilds from the snapshot, leaves the resume decision to the server and answers the ack from the log", async () => {
    const { agent, socket, seen } = setup();
    agent.deliver({
      type: "cf_agent_log_resync",
      log: "cf_chat",
      epoch: "e",
      seq: 3,
      id: agent.subscribeId(),
      snapshot: {
        messages: [{ id: "u1" }],
        active: {
          requestId: "r1",
          continuation: false,
          seqBase: 0,
          chunks: ['{"type":"start"}', '{"type":"text-start","id":"t"}']
        }
      }
    });
    expect(seen).toEqual([
      {
        type: "cf_agent_chat_messages",
        messages: [{ id: "u1" }],
        connect: true
      }
    ]);
    // The request goes to the server, which decides; its answer comes through.
    socket.send(
      JSON.stringify({ type: "cf_agent_stream_resume_request", probeId: "p" })
    );
    expect(agent.sent.at(-1)).toEqual({
      type: "cf_agent_stream_resume_request",
      probeId: "p"
    });
    agent.deliver({ type: "cf_agent_stream_resuming", id: "r1", probeId: "p" });
    expect(seen.at(-1)).toEqual({
      type: "cf_agent_stream_resuming",
      id: "r1",
      probeId: "p"
    });
    // The ack is answered with the stream so far from the log; the server
    // gets it too, to end the stream if its producer is gone.
    socket.send(
      JSON.stringify({ type: "cf_agent_stream_resume_ack", id: "r1" })
    );
    expect(agent.sent.at(-1)).toEqual({
      type: "cf_agent_stream_resume_ack",
      id: "r1"
    });
    await flush();
    expect(seen.slice(2)).toEqual([
      {
        type: RESPONSE,
        id: "r1",
        body: '{"type":"start"}',
        done: false,
        replay: true,
        seq: 0
      },
      {
        type: RESPONSE,
        id: "r1",
        body: '{"type":"text-start","id":"t"}',
        done: false,
        replay: true,
        seq: 1
      },
      {
        type: RESPONSE,
        id: "r1",
        body: "",
        done: false,
        replay: true,
        replayComplete: true
      }
    ]);
    // Live events continue the stream, unwrapped.
    agent.deliver({
      type: "cf_agent_log_events",
      log: "cf_chat",
      events: [
        {
          seq: 4,
          data: {
            frame: { type: RESPONSE, id: "r1", body: "x", done: false, seq: 2 }
          }
        }
      ]
    });
    expect(seen.at(-1)).toEqual({
      type: RESPONSE,
      id: "r1",
      body: "x",
      done: false,
      seq: 2
    });
  });

  it("leaves an ack for anything but the stream in flight to the server", async () => {
    const { agent, socket, seen } = setup();
    agent.deliver({
      type: "cf_agent_log_resync",
      log: "cf_chat",
      epoch: "e",
      seq: 0,
      id: agent.subscribeId(),
      snapshot: { messages: [] }
    });
    socket.send(
      JSON.stringify({ type: "cf_agent_stream_resume_ack", id: "c1" })
    );
    await flush();
    expect(agent.sent.at(-1)).toEqual({
      type: "cf_agent_stream_resume_ack",
      id: "c1"
    });
    expect(seen.map((f) => f.type)).toEqual(["cf_agent_chat_messages"]);
  });

  it("holds an ack sent while reconnecting until the log caught up", async () => {
    const { agent, socket, seen } = setup();
    agent.deliver({
      type: "cf_agent_log_resync",
      log: "cf_chat",
      epoch: "e",
      seq: 0,
      id: agent.subscribeId(),
      snapshot: { messages: [] }
    });
    agent.dispatchEvent(new Event("close"));
    socket.send(
      JSON.stringify({ type: "cf_agent_stream_resume_ack", id: "r3" })
    );
    await flush();
    expect(seen.map((f) => f.type)).toEqual(["cf_agent_chat_messages"]);
    agent.dispatchEvent(new Event("open"));
    const resubscribe = agent.sent
      .filter((f) => f.type === "cf_agent_log_subscribe")
      .at(-1)!;
    agent.deliver({
      type: "cf_agent_log_events",
      log: "cf_chat",
      id: resubscribe.id,
      events: [
        {
          seq: 1,
          data: { frame: { type: RESPONSE, id: "r3", body: "a", done: false } }
        }
      ]
    });
    agent.deliver({
      type: "cf_agent_log_synced",
      log: "cf_chat",
      epoch: "e",
      seq: 1,
      id: resubscribe.id
    });
    await flush();
    expect(seen.slice(-2)).toEqual([
      { type: RESPONSE, id: "r3", body: "a", done: false, replay: true },
      {
        type: RESPONSE,
        id: "r3",
        body: "",
        done: false,
        replay: true,
        replayComplete: true
      }
    ]);
  });

  it("skips events that name this connection, and broadcasts the log will carry", () => {
    const { agent, seen } = setup();
    agent.deliver({
      type: "cf_agent_log_resync",
      log: "cf_chat",
      epoch: "e",
      seq: 0,
      id: agent.subscribeId(),
      snapshot: { messages: [] }
    });
    agent.deliver({
      type: "cf_agent_chat_messages",
      messages: [],
      inLog: true
    });
    agent.deliver({
      type: "cf_agent_log_events",
      log: "cf_chat",
      events: [
        {
          seq: 1,
          data: {
            frame: { type: "cf_agent_chat_messages", messages: [] },
            without: ["me"]
          }
        },
        {
          seq: 2,
          data: { frame: { type: "cf_agent_message_updated", message: {} } }
        }
      ]
    });
    agent.deliver({ type: RESPONSE, id: "direct", body: "", done: true });
    expect(seen.map((f) => f.type)).toEqual([
      "cf_agent_chat_messages",
      "cf_agent_message_updated",
      RESPONSE
    ]);
  });

  it("hides a drop and reconnect, and passes on a final close", () => {
    const { agent, events } = setup();
    agent.deliver({
      type: "cf_agent_log_resync",
      log: "cf_chat",
      epoch: "e",
      seq: 0,
      id: agent.subscribeId(),
      snapshot: { messages: [] }
    });
    agent.dispatchEvent(new Event("close"));
    agent.dispatchEvent(new Event("open"));
    expect(events).toEqual([]);
    agent.shouldReconnect = false;
    agent.dispatchEvent(new Event("close"));
    expect(events).toEqual(["close"]);
  });

  it("passes broadcasts through until the server answers the subscribe", () => {
    const { agent, seen } = setup();
    agent.deliver({
      type: RESPONSE,
      id: "r1",
      body: "a",
      done: false,
      inLog: true
    });
    expect(seen.map((f) => f.id)).toEqual(["r1"]);
  });

  it("applies a reply meant for this tab only, and drops one for another tab", () => {
    const { agent, seen } = setup();
    agent.deliver({
      type: "cf_agent_log_resync",
      log: "cf_chat",
      epoch: "e",
      seq: 0,
      id: agent.subscribeId(),
      snapshot: { messages: [] }
    });
    agent.deliver({
      type: "cf_agent_log_events",
      log: "cf_chat",
      events: [
        {
          seq: 1,
          data: {
            frame: { type: RESPONSE, id: "x", body: "", done: true },
            only: ["other"]
          }
        },
        {
          seq: 2,
          data: {
            frame: { type: RESPONSE, id: "y", body: "", done: true },
            only: ["me"]
          }
        }
      ]
    });
    expect(seen.slice(1).map((f) => f.id)).toEqual(["y"]);
  });

  it("marks terminal frames caught up from the cursor as replayed", () => {
    const { agent, seen } = setup();
    agent.deliver({
      type: "cf_agent_log_resync",
      log: "cf_chat",
      epoch: "e",
      seq: 0,
      id: agent.subscribeId(),
      snapshot: { messages: [] }
    });
    agent.dispatchEvent(new Event("close"));
    agent.dispatchEvent(new Event("open"));
    const id = agent.sent
      .filter((f) => f.type === "cf_agent_log_subscribe")
      .at(-1)!.id;
    agent.deliver({
      type: "cf_agent_log_events",
      log: "cf_chat",
      id,
      events: [
        {
          seq: 1,
          data: { frame: { type: RESPONSE, id: "r", body: "a", done: false } }
        },
        {
          seq: 2,
          data: { frame: { type: RESPONSE, id: "r", body: "", done: true } }
        }
      ]
    });
    expect(seen.slice(1)).toEqual([
      { type: RESPONSE, id: "r", body: "a", done: false },
      { type: RESPONSE, id: "r", body: "", done: true, replay: true }
    ]);
  });

  it("asks for the snapshot when a replay meets a frame the log could not hold", () => {
    const { agent } = setup();
    agent.deliver({
      type: "cf_agent_log_resync",
      log: "cf_chat",
      epoch: "e",
      seq: 0,
      id: agent.subscribeId(),
      snapshot: { messages: [] }
    });
    agent.dispatchEvent(new Event("close"));
    agent.dispatchEvent(new Event("open"));
    const id = agent.sent
      .filter((f) => f.type === "cf_agent_log_subscribe")
      .at(-1)!.id;
    agent.deliver({
      type: "cf_agent_log_events",
      log: "cf_chat",
      id,
      events: [{ seq: 1, data: { resync: true } }]
    });
    const last = agent.sent.at(-1)!;
    expect(last.type).toBe("cf_agent_log_subscribe");
    expect(last).not.toHaveProperty("cursor");
  });

  it("shows the chat code a reconnect when a later resync replaces its state", () => {
    const { agent, seen, events } = setup();
    const resync = (seq: number, id: unknown) =>
      agent.deliver({
        type: "cf_agent_log_resync",
        log: "cf_chat",
        epoch: "e2",
        seq,
        id,
        snapshot: { messages: [] }
      });
    resync(0, agent.subscribeId());
    expect(events).toEqual([]);
    agent.dispatchEvent(new Event("close"));
    agent.dispatchEvent(new Event("open"));
    resync(
      5,
      agent.sent.filter((f) => f.type === "cf_agent_log_subscribe").at(-1)!.id
    );
    expect(events).toEqual(["close", "open"]);
    expect(seen.at(-1)).toMatchObject({
      type: "cf_agent_chat_recovering",
      recovering: false
    });
  });

  it("stops following when the last hook releases it", () => {
    const { agent, socket } = setup();
    socket.release();
    expect(agent.sent.at(-1)).toEqual({
      type: "cf_agent_log_unsubscribe",
      log: "cf_chat"
    });
  });
});
