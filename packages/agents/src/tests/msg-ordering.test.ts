import { createExecutionContext, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker, { type Env } from "./worker";
import { MessageType } from "../types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

async function connectWS(path: string) {
  const ctx = createExecutionContext();
  const req = new Request(`http://example.com${path}`, {
    headers: { Upgrade: "websocket" }
  });
  const res = await worker.fetch(req, env, ctx);
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return { ws, ctx };
}

describe("WebSocket ordering / races", () => {
  it("onMessage never runs before onConnect has tagged the connection", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectWS(`/agents/tag-agent/${room}`);

    // The first 4 messages should be:
    // 1. State update due to our intialState
    // 2. Initial state sharing
    // 3. MCP servers
    // 4. Our echo message
    const firstMessages: { type: string; tagged?: boolean }[] = [];
    let resolvePromise: (value: boolean) => void;
    const donePromise = new Promise((res) => {
      resolvePromise = res;
    });
    // Timeout if we don't get a message in the first 100ms
    const _t = setTimeout(() => resolvePromise(false), 100);

    // Add listener before we send anything
    ws.addEventListener("message", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      if (firstMessages.length < 4) firstMessages.push(data);
      else {
        resolvePromise(true);
        ws.close();
      }
    });

    // Hammer a burst right away, if ordering is wrong
    // the first echo might not be tagged
    for (let i = 0; i < 25; i++) ws.send("ping");

    // Wait to receive at least the first 3 messages
    const done = await donePromise;
    expect(done).toBe(true);

    const first = firstMessages[0];
    expect(first.type).toBe(MessageType.CF_AGENT_STATE);
    const second = firstMessages[1];
    expect(second.type).toBe(MessageType.CF_AGENT_STATE);
    const third = firstMessages[2];
    expect(third.type).toBe(MessageType.CF_AGENT_MCP_SERVERS);

    const fourth = firstMessages[3];
    expect(fourth).toBeDefined();
    expect(fourth.type).toBe("echo");
    expect(fourth.tagged).toBe(true);
  });
});
