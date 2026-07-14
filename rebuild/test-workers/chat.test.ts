import { SELF, env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChatAgentDO } from "./worker.js";

type Frame = Record<string, unknown> & { type: string };

let chatCounter = 0;

function uniqueName(label: string): string {
  return `${label}-${chatCounter++}`;
}

function chatUrl(name: string, connectionId: string): string {
  return `https://x/agents/chat-agent-do/${encodeURIComponent(name)}?_pk=${encodeURIComponent(
    connectionId
  )}`;
}

async function connect(
  name: string,
  connectionId: string
): Promise<{
  ws: WebSocket;
  frames: Frame[];
  send(frame: unknown): void;
  close(): void;
}> {
  const response = await SELF.fetch(chatUrl(name, connectionId), {
    headers: { Upgrade: "websocket" }
  });
  expect(response.status).toBe(101);

  const ws = response.webSocket;
  expect(ws).not.toBeNull();
  if (!ws) throw new Error("upgrade did not return a WebSocket");

  const frames: Frame[] = [];
  ws.accept();
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    frames.push(JSON.parse(event.data) as Frame);
  });

  return {
    ws,
    frames,
    send(frame: unknown): void {
      ws.send(JSON.stringify(frame));
    },
    close(): void {
      ws.close();
    }
  };
}

async function waitForFrame(
  frames: Frame[],
  predicate: (frame: Frame) => boolean,
  label: string
): Promise<Frame> {
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    const found = frames.find(predicate);
    if (found) return found;
    await scheduler.wait(10);
  }
  throw new Error(
    `Timed out waiting for ${label}. Frames: ${JSON.stringify(frames)}`
  );
}

function framesOfType(frames: Frame[], type: string): Frame[] {
  return frames.filter((frame) => frame.type === type);
}

function messageText(message: unknown): string {
  if (
    typeof message !== "object" ||
    message === null ||
    !("parts" in message) ||
    !Array.isArray(message.parts)
  ) {
    return "";
  }
  return message.parts
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
    )
    .map((part) => part.text)
    .join("");
}

describe("hostAgent chat over Durable Object WebSockets", () => {
  it("upgrades through the router and syncs identity plus empty history", async () => {
    const name = uniqueName("handshake");
    const client = await connect(name, "c1");

    const identity = await waitForFrame(
      client.frames,
      (frame) => frame.type === "cf_agent_identity",
      "identity"
    );
    expect(identity).toMatchObject({
      type: "cf_agent_identity",
      className: "ChatAgent",
      name,
      connectionId: "c1"
    });

    expect(
      await waitForFrame(
        client.frames,
        (frame) => frame.type === "cf_agent_chat_messages",
        "chat message sync"
      )
    ).toMatchObject({ type: "cf_agent_chat_messages", messages: [] });
  });

  it("streams chat responses and queues a second turn", async () => {
    const name = uniqueName("chat");
    const client = await connect(name, "c1");
    await waitForFrame(
      client.frames,
      (frame) => frame.type === "cf_agent_chat_messages",
      "initial sync"
    );

    client.send({
      type: "cf_agent_use_chat_request",
      id: "req_1",
      input: "hello"
    });
    await waitForFrame(
      client.frames,
      (frame) =>
        frame.type === "cf_agent_message_updated" &&
        frame.requestId === "req_1" &&
        messageText(frame.message).includes("worker response 1"),
      "first final message"
    );
    expect(
      framesOfType(client.frames, "cf_agent_use_chat_response").some(
        (frame) => frame.id === "req_1"
      )
    ).toBe(true);

    client.send({
      type: "cf_agent_use_chat_request",
      id: "req_2",
      input: "again"
    });
    await waitForFrame(
      client.frames,
      (frame) =>
        frame.type === "cf_agent_message_updated" &&
        frame.requestId === "req_2" &&
        messageText(frame.message).includes("worker response 2"),
      "second final message"
    );
  });

  it("reconnects to the same name and receives persisted history", async () => {
    const name = uniqueName("reconnect");
    const first = await connect(name, "c1");
    await waitForFrame(
      first.frames,
      (frame) => frame.type === "cf_agent_chat_messages",
      "initial sync"
    );

    first.send({
      type: "cf_agent_use_chat_request",
      id: "req_1",
      input: "persist"
    });
    await waitForFrame(
      first.frames,
      (frame) =>
        frame.type === "cf_agent_message_updated" &&
        frame.requestId === "req_1",
      "final message"
    );
    first.close();

    const second = await connect(name, "c2");
    const sync = await waitForFrame(
      second.frames,
      (frame) =>
        frame.type === "cf_agent_chat_messages" &&
        Array.isArray(frame.messages) &&
        frame.messages.length === 2,
      "persisted history sync"
    );
    expect(
      (sync.messages as unknown[]).some((message) =>
        messageText(message).includes("worker response 1")
      )
    ).toBe(true);
  });

  it("broadcasts state changes to other sockets without echoing to the origin", async () => {
    const name = uniqueName("state");
    const a = await connect(name, "a");
    const b = await connect(name, "b");

    await waitForFrame(
      a.frames,
      (frame) => frame.type === "cf_agent_state",
      "a initial state"
    );
    await waitForFrame(
      b.frames,
      (frame) => frame.type === "cf_agent_state",
      "b initial state"
    );

    a.send({ type: "cf_agent_state", state: { count: 7 } });
    await waitForFrame(
      b.frames,
      (frame) =>
        frame.type === "cf_agent_state" &&
        JSON.stringify(frame.state) === '{"count":7}',
      "state broadcast"
    );

    expect(
      framesOfType(a.frames, "cf_agent_state").map((frame) => frame.state)
    ).toEqual([{ count: 0 }]);
  });

  it("reports no stream to resume while idle", async () => {
    const name = uniqueName("resume");
    const client = await connect(name, "c1");
    await waitForFrame(
      client.frames,
      (frame) => frame.type === "cf_agent_chat_messages",
      "initial sync"
    );

    client.send({ type: "cf_agent_stream_resume_request" });
    await waitForFrame(
      client.frames,
      (frame) => frame.type === "cf_agent_stream_resume_none",
      "resume none"
    );
  });

  it("dispatches scheduled callbacks through the real alarm slot", async () => {
    const name = uniqueName("alarm");
    const id = env.CHAT_AGENT_DO.idFromName(name);
    const stub = env.CHAT_AGENT_DO.get(id) as DurableObjectStub<ChatAgentDO>;

    await stub.__init({ name });
    await stub.scheduleNote();
    await stub.makeScheduledNoteDue();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.noteFiredCount()).toBe(1);
  });

  it("__destroy wipes chat history before the next connection sync", async () => {
    const name = uniqueName("destroy");
    const client = await connect(name, "c1");
    await waitForFrame(
      client.frames,
      (frame) => frame.type === "cf_agent_chat_messages",
      "initial sync"
    );

    client.send({
      type: "cf_agent_use_chat_request",
      id: "req_1",
      input: "remove me"
    });
    await waitForFrame(
      client.frames,
      (frame) =>
        frame.type === "cf_agent_message_updated" &&
        frame.requestId === "req_1",
      "final message"
    );

    const stub = env.CHAT_AGENT_DO.get(
      env.CHAT_AGENT_DO.idFromName(name)
    ) as DurableObjectStub<ChatAgentDO>;
    await stub.__destroy();

    const fresh = await connect(name, "c2");
    expect(
      await waitForFrame(
        fresh.frames,
        (frame) => frame.type === "cf_agent_chat_messages",
        "empty post-destroy sync"
      )
    ).toMatchObject({ type: "cf_agent_chat_messages", messages: [] });
  });
});
