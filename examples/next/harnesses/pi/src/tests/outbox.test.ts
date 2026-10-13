import { env } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { describe, expect, it } from "vitest";
import { PiCommandOutbox } from "../outbox";
import type { PiServerMessage } from "../protocol";

async function connect(name: string): Promise<WebSocket> {
  const response = await routeAgentRequest(
    new Request(`https://example.com/agents/pi-harness-test/${name}`, {
      headers: { Upgrade: "websocket" }
    }),
    env
  );
  expect(response?.status).toBe(101);
  const socket = response!.webSocket as WebSocket;
  socket.accept();
  return socket;
}

/** Resolve with the first frame `match` accepts. */
function next(
  socket: WebSocket,
  match: (message: PiServerMessage) => boolean
): Promise<PiServerMessage> {
  return new Promise((resolve) => {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data) as PiServerMessage;
      if (match(message)) resolve(message);
    });
  });
}

/** The part of `localStorage` the outbox uses, in memory. */
function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key)
  };
}

describe("the client command outbox", () => {
  it("keeps unacknowledged submits in storage across a reload", () => {
    const storage = memoryStorage();
    const before = new PiCommandOutbox(storage, "pi-outbox:a");
    const submit = before.submit("hello");

    // A reload builds a new outbox over the same storage.
    const after = new PiCommandOutbox(storage, "pi-outbox:a");
    expect(after.pending()).toEqual([submit]);
    expect(new PiCommandOutbox(storage, "pi-outbox:b").pending()).toEqual([]);

    after.receive({ type: "result", id: submit.id!, result: null });
    expect(new PiCommandOutbox(storage, "pi-outbox:a").pending()).toEqual([]);
  });

  it("ignores stored submits it cannot read", () => {
    const storage = memoryStorage();
    storage.setItem("pi-outbox:a", "{not json");
    expect(new PiCommandOutbox(storage, "pi-outbox:a").pending()).toEqual([]);
  });

  it("names each submit with a durable operation id and keeps it until acknowledged", () => {
    const outbox = new PiCommandOutbox();
    const submit = outbox.submit("hello", "followUp");

    expect(submit).toMatchObject({ type: "submit", input: "hello" });
    expect(submit.operationId).toBe(submit.id);
    expect(outbox.pending()).toEqual([submit]);

    outbox.receive({ type: "result", id: submit.id!, result: null });
    expect(outbox.pending()).toEqual([]);
  });

  it("drops a command the server rejected", () => {
    const outbox = new PiCommandOutbox();
    const submit = outbox.submit("hello");
    outbox.receive({ type: "error", id: submit.id, message: "rejected" });
    expect(outbox.pending()).toEqual([]);
  });

  it("replays an unacknowledged submit after a reconnect without running it twice", async () => {
    const name = crypto.randomUUID();
    const storage = memoryStorage();
    let outbox = new PiCommandOutbox(storage, `pi-outbox:${name}`);
    const submit = outbox.submit("echo once");

    // The server admits the prompt, but the connection drops before the
    // client reads its result.
    const first = await connect(name);
    const admitted = next(
      first,
      (message) => message.type === "result" && message.id === submit.id
    );
    for (const command of outbox.pending()) first.send(JSON.stringify(command));
    await admitted;
    first.close();
    // The tab reloads before it reads the result.
    outbox = new PiCommandOutbox(storage, `pi-outbox:${name}`);
    expect(outbox.pending()).toEqual([submit]);

    const second = await connect(name);
    const replayed = next(
      second,
      (message) => message.type === "result" && message.id === submit.id
    );
    for (const command of outbox.pending()) {
      second.send(JSON.stringify(command));
    }
    const result = await replayed;
    outbox.receive(result);
    second.close();

    expect(result).toMatchObject({ result: { accepted: false } });
    expect(outbox.pending()).toEqual([]);
    const stub = env.PI_HARNESS_TEST.getByName(name);
    expect(
      (await stub.messages()).filter((text) => text === "echo once")
    ).toHaveLength(1);
  });
});
