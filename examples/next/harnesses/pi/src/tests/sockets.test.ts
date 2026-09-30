import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { routeAgentRequest } from "agents";
import { describe, expect, it } from "vitest";
import type { PiServerMessage } from "../protocol";
import { EMPTY_VIEW, reduceEvents, type PiSessionView } from "../view";

async function connect(name: string, query = ""): Promise<WebSocket> {
  const response = await routeAgentRequest(
    new Request(`https://example.com/agents/pi-harness-test/${name}${query}`, {
      headers: { Upgrade: "websocket" }
    }),
    env
  );
  expect(response?.status).toBe(101);
  const socket = response!.webSocket as WebSocket;
  socket.accept();
  return socket;
}

/** Folds every `events` frame into a view, as the browser hook does. */
function follow(socket: WebSocket) {
  let view: PiSessionView = EMPTY_VIEW;
  const frames: PiServerMessage[] = [];
  const waiters: Array<() => void> = [];
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const message = JSON.parse(event.data) as
      | PiServerMessage
      | { type: string };
    if (!("type" in message)) return;
    frames.push(message as PiServerMessage);
    if (message.type === "events") {
      view = reduceEvents(
        view,
        (message as Extract<PiServerMessage, { type: "events" }>).events
      );
    }
    for (const waiter of waiters.splice(0)) waiter();
  });
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 500 && !check(); i++) {
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 20);
      });
    }
    if (!check()) throw new Error("Condition never held");
  };
  return { view: () => view, frames, until };
}

describe("the session WebSocket protocol", () => {
  it("sends a snapshot, then pi's events for a run started over the socket", async () => {
    const name = crypto.randomUUID();
    const socket = await connect(name);
    const client = follow(socket);
    await client.until(() =>
      client.frames.some((frame) => frame.type === "events")
    );
    expect(client.frames.find((frame) => frame.type === "hello")).toMatchObject(
      {
        session: "1",
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "multiply" })
        ])
      }
    );

    socket.send(
      JSON.stringify({ type: "submit", id: "c1", input: "multiply 7" })
    );
    await client.until(() =>
      client
        .view()
        .messages.some(
          (message) =>
            message.role === "assistant" &&
            message.parts.some(
              (part) => part.type === "text" && part.text === "tool said: 21"
            )
        )
    );
    await client.until(() => !client.view().running);
    expect(
      client.frames.find((frame) => frame.type === "result")
    ).toMatchObject({
      id: "c1",
      result: { session: "1", accepted: true }
    });
    socket.close();
  });

  it("gives a client that joins mid-run the running state", async () => {
    const name = crypto.randomUUID();
    const stub = env.PI_HARNESS_TEST.getByName(name);
    const receipt = await stub.submit("gate");
    await stub.gateStarted(1);

    const socket = await connect(name);
    const client = follow(socket);
    await client.until(() => client.view().running);
    expect(client.view().tools.map((tool) => tool.name)).toEqual(["gate"]);
    expect(client.view().tools[0]?.output).toBe("run 1\n");

    await stub.release();
    await stub.wait(receipt.operationId);
    await client.until(() => !client.view().running);
    expect(client.view().messages.at(-1)?.parts[0]).toEqual({
      type: "text",
      text: "tool said: released after 1 runs"
    });
    socket.close();
  });

  it("keeps serving a hibernated socket after the object is evicted", async () => {
    const name = crypto.randomUUID();
    const stub = env.PI_HARNESS_TEST.getByName(name);
    const socket = await connect(name);
    const client = follow(socket);
    await client.until(() =>
      client.frames.some((frame) => frame.type === "events")
    );

    await evictDurableObject(stub);
    const snapshots = () =>
      client.frames.filter(
        (frame) =>
          frame.type === "events" && frame.events[0]?.type === "snapshot"
      ).length;
    const before = snapshots();
    // The next call restarts the object; its start re-watches the socket.
    const result = await stub.prompt("after hibernation");
    expect(result.text).toBe("echo: after hibernation");
    await client.until(() =>
      client
        .view()
        .messages.some((message) =>
          message.parts.some(
            (part) =>
              part.type === "text" && part.text === "echo: after hibernation"
          )
        )
    );
    expect(snapshots()).toBe(before + 1);
    socket.close();
  });
});
