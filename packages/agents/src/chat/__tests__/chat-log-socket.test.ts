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

  it("answers an ack for a stream with no chunks yet with an empty replay", async () => {
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
    expect(seen.at(-1)).toEqual({
      type: RESPONSE,
      id: "c1",
      body: "",
      done: false,
      replay: true,
      replayComplete: true
    });
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
});
