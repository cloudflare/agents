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

    // The first messages should include:
    // - Identity (must be first)
    // - State messages (1-2 depending on timing)
    // - MCP servers
    // - Echo message (must have tagged=true to prove onConnect ran first)
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
      if (firstMessages.length < 5) firstMessages.push(data);
      else {
        resolvePromise(true);
        ws.close();
      }
    });

    // Hammer a burst right away, if ordering is wrong
    // the first echo might not be tagged
    for (let i = 0; i < 25; i++) ws.send("ping");

    // Wait to receive at least the first messages
    const done = await donePromise;
    expect(done).toBe(true);

    // Identity must come first
    const first = firstMessages[0];
    expect(first.type).toBe(MessageType.CF_AGENT_IDENTITY);

    // The remaining setup messages (state, mcp servers) can arrive in any order
    // due to async setState behavior. Just verify we get them all.
    const setupMessages = firstMessages.slice(1, 4);
    const setupTypes = setupMessages.map((m) => m.type);
    expect(setupTypes).toContain(MessageType.CF_AGENT_STATE);
    expect(setupTypes).toContain(MessageType.CF_AGENT_MCP_SERVERS);

    // The key assertion: echo message must have tagged=true
    // This proves onConnect ran and tagged the connection before onMessage processed pings
    const fifth = firstMessages[4];
    expect(fifth).toBeDefined();
    expect(fifth.type).toBe("echo");
    expect(fifth.tagged).toBe(true);
  });
});
