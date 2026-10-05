import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { routeAgentRequest } from "agents";
import { describe, expect, it } from "vitest";
import type { OpenCodeServerMessage } from "../protocol";
import { EMPTY_VIEW, reduceEvents, type OpenCodeSessionView } from "../view";

const AGENT = "opencode-harness-test";

async function connect(name: string, query = ""): Promise<WebSocket> {
  const response = await routeAgentRequest(
    new Request(`https://example.com/agents/${AGENT}/${name}${query}`, {
      headers: { Upgrade: "websocket" }
    }),
    env
  );
  expect(response?.status).toBe(101);
  const socket = response!.webSocket as WebSocket;
  socket.accept();
  return socket;
}

function follow(socket: WebSocket) {
  let view: OpenCodeSessionView = EMPTY_VIEW;
  const frames: OpenCodeServerMessage[] = [];
  const waiters: Array<() => void> = [];
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const message = JSON.parse(event.data) as OpenCodeServerMessage;
    frames.push(message);
    if (message.type === "events") view = reduceEvents(view, message.events);
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

function says(view: OpenCodeSessionView, text: string): boolean {
  return view.messages.some(
    (message) =>
      message.role === "assistant" &&
      message.parts.some((part) => part.type === "text" && part.text === text)
  );
}

describe("the session WebSocket protocol", () => {
  it("sends a snapshot, then the session's events for a turn started over the socket", async () => {
    const socket = await connect(crypto.randomUUID());
    const client = follow(socket);
    await client.until(() =>
      client.frames.some((frame) => frame.type === "events")
    );
    expect(client.frames.find((frame) => frame.type === "hello")).toMatchObject(
      {
        session: expect.stringMatching(/^ses_/),
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "multiply" })
        ])
      }
    );

    socket.send(
      JSON.stringify({ type: "submit", id: "c1", input: "multiply 7" })
    );
    await client.until(() => says(client.view(), "tool said: 21"));
    await client.until(() => !client.view().running);
    expect(
      client.frames.find((frame) => frame.type === "result")
    ).toMatchObject({ id: "c1", result: { accepted: true } });

    expect(
      client.view().messages.flatMap((message) => message.parts)
    ).toContainEqual(
      expect.objectContaining({ type: "tool-result", name: "multiply" })
    );
    socket.close();
  });

  it("gives a client that joins mid-turn the running state", async () => {
    const name = crypto.randomUUID();
    const stub = env.OPENCODE_HARNESS_TEST.getByName(name);
    const receipt = await stub.submit("gate");
    await stub.gateStarted(1);

    const socket = await connect(name);
    const client = follow(socket);
    await client.until(() => client.view().running);

    await stub.release();
    expect(await stub.wait(receipt.operationId)).toMatchObject({
      status: "done",
      text: "tool said: released after 1 runs"
    });
    await client.until(
      () =>
        !client.view().running &&
        says(client.view(), "tool said: released after 1 runs")
    );
    socket.close();
  });

  it("keeps serving a hibernated socket after the object is evicted", async () => {
    const name = crypto.randomUUID();
    const stub = env.OPENCODE_HARNESS_TEST.getByName(name);
    const socket = await connect(name);
    const client = follow(socket);
    await client.until(() =>
      client.frames.some((frame) => frame.type === "events")
    );

    await stub.dispose();
    await evictDurableObject(stub);

    const result = await stub.prompt("after hibernation");
    expect(result.text).toBe("echo: after hibernation");
    await client.until(() => says(client.view(), "echo: after hibernation"));
    socket.close();
  });
});

describe("the OpenCode CLI's route", () => {
  it("serves OpenCode's HTTP API under the object's own URL", async () => {
    const name = crypto.randomUUID();
    const stub = env.OPENCODE_HARNESS_TEST.getByName(name);
    await stub.prompt("hello");

    const response = await routeAgentRequest(
      new Request(`https://example.com/agents/${AGENT}/${name}/api/session`),
      env
    );
    expect(response?.status).toBe(200);
    const sessions = (await response!.json()) as {
      data: { id: string; title?: string }[];
    };
    expect(sessions.data).toContainEqual(
      expect.objectContaining({ id: expect.stringMatching(/^ses_/) })
    );
  });
});
