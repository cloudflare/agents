import { exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { MessageType } from "../types";

async function connectWS(path: string) {
  const res = await exports.default.fetch(`http://example.com${path}`, {
    headers: { Upgrade: "websocket" }
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return { ws };
}

describe("WebSocket ordering / races", () => {
  it("onMessage never runs before onConnect has tagged the connection", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectWS(`/agents/tag-agent/${room}`);

    // We expect, in order:
    // 1. Identity (must be first)
    // 2-3. State + MCP servers (any order)
    // 4+. Echo messages (must have tagged=true to prove onConnect ran first)
    const messages: { type: string; tagged?: boolean }[] = [];
    let resolve: (value: void) => void;
    let reject: (reason: Error) => void;
    const donePromise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const safetyTimeout = setTimeout(
      () =>
        reject(
          new Error(`Timed out after receiving ${messages.length} messages`)
        ),
      5000
    );

    ws.addEventListener("message", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      messages.push(data);
      if (data.type === "echo") {
        clearTimeout(safetyTimeout);
        resolve();
      }
    });

    // Hammer a burst right away — if ordering is wrong
    // the first echo might not be tagged
    for (let i = 0; i < 25; i++) ws.send("ping");

    await donePromise;
    ws.close();

    // Identity must come first
    expect(messages[0].type).toBe(MessageType.CF_AGENT_IDENTITY);

    // The remaining setup messages (state, mcp servers) can arrive in any order
    // due to async setState behavior. Just verify we get them all before any echo.
    const echoIdx = messages.findIndex((m) => m.type === "echo");
    const setupMessages = messages.slice(1, echoIdx);
    const setupTypes = setupMessages.map((m) => m.type);
    expect(setupTypes).toContain(MessageType.CF_AGENT_STATE);
    expect(setupTypes).toContain(MessageType.CF_AGENT_MCP_SERVERS);

    // The key assertion: the first echo must have tagged=true.
    // This proves onConnect ran and tagged the connection before onMessage processed pings.
    const firstEcho = messages[echoIdx];
    expect(firstEcho.tagged).toBe(true);
  });
});
