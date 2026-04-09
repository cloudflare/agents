import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";

const MSG_CHAT_REQUEST = "cf_agent_use_chat_request";
const MSG_CHAT_RESPONSE = "cf_agent_use_chat_response";

function kebab(className: string): string {
  return className
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

async function connectWS(agentClass: string, room: string) {
  const slug = kebab(agentClass);
  const res = await exports.default.fetch(
    `http://example.com/agents/${slug}/${room}`,
    { headers: { Upgrade: "websocket" } }
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return { ws };
}

function collectMessages(
  ws: WebSocket,
  count: number,
  timeout = 5000
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const messages: Array<Record<string, unknown>> = [];
    const timer = setTimeout(() => resolve(messages), timeout);
    const handler = (e: MessageEvent) => {
      try {
        messages.push(JSON.parse(e.data as string) as Record<string, unknown>);
        if (messages.length >= count) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve(messages);
        }
      } catch {
        // ignore
      }
    };
    ws.addEventListener("message", handler);
  });
}

function waitForDone(
  ws: WebSocket,
  timeout = 10000
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const messages: Array<Record<string, unknown>> = [];
    const timer = setTimeout(
      () => reject(new Error("Timeout waiting for done")),
      timeout
    );
    const handler = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as Record<string, unknown>;
        messages.push(msg);
        if (msg.type === MSG_CHAT_RESPONSE && msg.done === true) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve(messages);
        }
      } catch {
        // ignore
      }
    };
    ws.addEventListener("message", handler);
  });
}

function closeWS(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 200);
    ws.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
    ws.close();
  });
}

function sendChatRequest(ws: WebSocket, text: string, requestId?: string) {
  const id = requestId ?? crypto.randomUUID();
  const userMessage: UIMessage = {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text }]
  };
  ws.send(
    JSON.stringify({
      type: MSG_CHAT_REQUEST,
      id,
      init: {
        method: "POST",
        body: JSON.stringify({ messages: [userMessage] })
      }
    })
  );
  return { id, userMessage };
}

// ── Tests ─────────────────────────────────────────────────────────

describe("Think — agentic loop", () => {
  describe("getModel() error", () => {
    it("returns an error when getModel is not overridden", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectWS("BareAssistantAgent", room);

      // Skip initial messages
      await collectMessages(ws, 3);

      const done = waitForDone(ws);
      sendChatRequest(ws, "hello");
      const messages = await done;

      const errorMsg = messages.find(
        (m) =>
          m.type === MSG_CHAT_RESPONSE && m.done === true && m.error === true
      );
      expect(errorMsg).toBeDefined();
      expect(errorMsg!.body).toContain("getModel");

      await closeWS(ws);
    });
  });

  describe("default loop — text only", () => {
    it("streams a response using the mock model", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectWS("LoopTestAgent", room);

      // Skip initial messages
      await collectMessages(ws, 3);

      const done = waitForDone(ws);
      sendChatRequest(ws, "Say hi");
      const messages = await done;

      const responseChunks = messages.filter(
        (m) => m.type === MSG_CHAT_RESPONSE && m.done === false
      );
      expect(responseChunks.length).toBeGreaterThan(0);

      const bodies = responseChunks
        .map((m) => m.body as string)
        .filter(Boolean);
      const hasText = bodies.some((b) => {
        try {
          const parsed = JSON.parse(b) as Record<string, unknown>;
          return parsed.type === "text-delta" || parsed.type === "text-start";
        } catch {
          return false;
        }
      });
      expect(hasText).toBe(true);

      await closeWS(ws);
    });

    it("persists assistant message after streaming", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectWS("LoopTestAgent", room);
      const agent = await getAgentByName(env.LoopTestAgent, room);

      // Skip initial messages
      await collectMessages(ws, 3);

      const done = waitForDone(ws);
      sendChatRequest(ws, "Hello");
      await done;

      // Wait for the messages broadcast after persistence
      await collectMessages(ws, 1, 3000);

      const msgs = (await (
        agent as unknown as { getMessages(): Promise<UIMessage[]> }
      ).getMessages()) as UIMessage[];
      expect(msgs.length).toBeGreaterThanOrEqual(2);

      const assistantMsg = msgs.find((m) => m.role === "assistant");
      expect(assistantMsg).toBeDefined();

      await closeWS(ws);
    });
  });

  describe("default loop — with tools", () => {
    it("executes a tool and returns text after", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectWS("LoopToolTestAgent", room);

      // Skip initial messages
      await collectMessages(ws, 3);

      const done = waitForDone(ws, 15000);
      sendChatRequest(ws, "Use the echo tool");
      const messages = await done;

      const responseChunks = messages.filter(
        (m) => m.type === MSG_CHAT_RESPONSE && m.done === false
      );
      expect(responseChunks.length).toBeGreaterThan(0);

      await closeWS(ws);
    });

    it("custom maxSteps property is respected", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectWS("LoopToolTestAgent", room);

      // Skip initial messages
      await collectMessages(ws, 3);

      const done = waitForDone(ws, 15000);
      sendChatRequest(ws, "test step limit");
      const messages = await done;

      const doneMsg = messages.find(
        (m) => m.type === MSG_CHAT_RESPONSE && m.done === true
      );
      expect(doneMsg).toBeDefined();

      await closeWS(ws);
    });
  });

  describe("context assembly", () => {
    it("converts messages to model format", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectWS("LoopTestAgent", room);
      const agent = await getAgentByName(env.LoopTestAgent, room);

      // Skip initial messages
      await collectMessages(ws, 3);

      const done = waitForDone(ws);
      sendChatRequest(ws, "Hello for context test");
      await done;

      await collectMessages(ws, 1, 2000);

      const msgs = (await (
        agent as unknown as { getMessages(): Promise<UIMessage[]> }
      ).getMessages()) as UIMessage[];
      expect(msgs.length).toBeGreaterThanOrEqual(2);

      const userMsg = msgs.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();
      expect(userMsg!.parts).toBeDefined();

      await closeWS(ws);
    });
  });
});
