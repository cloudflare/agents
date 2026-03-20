import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";
import type { Session } from "../session/index";

// ── Wire protocol constants (must match agent.ts) ─────────────────
const MSG_CHAT_MESSAGES = "cf_agent_chat_messages";
const MSG_CHAT_REQUEST = "cf_agent_use_chat_request";
const MSG_CHAT_RESPONSE = "cf_agent_use_chat_response";

// ── Helpers ────────────────────────────────────────────────────────

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
    {
      headers: { Upgrade: "websocket" }
    }
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
        // ignore parse errors
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
        // ignore parse errors
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

describe("AssistantAgent — agentic loop", () => {
  describe("getModel() error", () => {
    it("returns an error when getModel is not overridden", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectWS("BareAssistantAgent", room);

      // Create a session first via RPC
      const agent = await getAgentByName(env.BareAssistantAgent, room);
      await (
        agent as unknown as { createSession(n: string): Promise<Session> }
      ).createSession("test");

      // Drain the session broadcast
      await collectMessages(ws, 1, 500);

      // Send a chat message — should get an error response
      const done = waitForDone(ws);
      sendChatRequest(ws, "hello");
      const messages = await done;

      // The last message should be a done message with error
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

      // Create session via RPC
      const agent = await getAgentByName(env.LoopTestAgent, room);
      const rpc = agent as unknown as {
        createSession(n: string): Promise<Session>;
        getMessages(): Promise<UIMessage[]>;
        getSessionHistory(id: string): Promise<UIMessage[]>;
        getSessions(): Promise<Session[]>;
      };
      await rpc.createSession("loop-test");
      await collectMessages(ws, 1, 500);

      // Send chat and wait for done
      const done = waitForDone(ws);
      sendChatRequest(ws, "Say hi");
      const messages = await done;

      // Should have response chunks and a done message
      const responseChunks = messages.filter(
        (m) => m.type === MSG_CHAT_RESPONSE && m.done === false
      );
      expect(responseChunks.length).toBeGreaterThan(0);

      // Verify the stream contains text content
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
      const rpc = agent as unknown as {
        createSession(n: string): Promise<Session>;
        getMessages(): Promise<UIMessage[]>;
        getSessionHistory(id: string): Promise<UIMessage[]>;
        getSessions(): Promise<Session[]>;
      };
      const session = (await rpc.createSession(
        "persist-test"
      )) as unknown as Session;
      await collectMessages(ws, 1, 500);

      // Send chat and wait for completion
      const done = waitForDone(ws);
      sendChatRequest(ws, "Hello");
      await done;

      // Wait for the cf_agent_chat_messages broadcast after persistence
      const postStream = await collectMessages(ws, 1, 3000);
      const chatMsgs = postStream.find((m) => m.type === MSG_CHAT_MESSAGES);

      // If no broadcast arrived, check via RPC
      if (!chatMsgs) {
        const history = (await rpc.getSessionHistory(
          session.id
        )) as unknown as UIMessage[];
        // Should have user + assistant
        expect(history.length).toBeGreaterThanOrEqual(2);
        const assistantMsg = history.find((m) => m.role === "assistant");
        expect(assistantMsg).toBeDefined();
      } else {
        const msgs = chatMsgs.messages as UIMessage[];
        expect(msgs.length).toBeGreaterThanOrEqual(2);
        const assistantMsg = msgs.find((m) => m.role === "assistant");
        expect(assistantMsg).toBeDefined();
      }

      await closeWS(ws);
    });
  });

  describe("default loop — with tools", () => {
    it("executes a tool and returns text after", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectWS("LoopToolTestAgent", room);

      const agent = await getAgentByName(env.LoopToolTestAgent, room);
      const rpc = agent as unknown as {
        createSession(n: string): Promise<Session>;
        getMessages(): Promise<UIMessage[]>;
        getSessionHistory(id: string): Promise<UIMessage[]>;
        getSessions(): Promise<Session[]>;
      };
      await rpc.createSession("tool-test");
      await collectMessages(ws, 1, 500);

      // Send chat and wait for done
      const done = waitForDone(ws, 15000);
      sendChatRequest(ws, "Use the echo tool");
      const messages = await done;

      // Should have response chunks
      const responseChunks = messages.filter(
        (m) => m.type === MSG_CHAT_RESPONSE && m.done === false
      );
      expect(responseChunks.length).toBeGreaterThan(0);

      // After completion, check persisted messages
      await collectMessages(ws, 1, 2000);

      const sessions = (await rpc.getSessions()) as unknown as Session[];
      const history = (await rpc.getSessionHistory(
        sessions[0].id
      )) as unknown as UIMessage[];

      // Should have at least user + assistant messages
      expect(history.length).toBeGreaterThanOrEqual(2);

      await closeWS(ws);
    });

    it("custom getMaxSteps is respected", async () => {
      const room = crypto.randomUUID();
      const agent = await getAgentByName(env.LoopToolTestAgent, room);
      const rpc = agent as unknown as {
        createSession(n: string): Promise<Session>;
      };
      await rpc.createSession("steps-test");

      // LoopToolTestAgent has getMaxSteps() = 3
      const { ws } = await connectWS("LoopToolTestAgent", room);

      // Drain session switch
      await collectMessages(ws, 1, 500);

      const done = waitForDone(ws, 15000);
      sendChatRequest(ws, "test step limit");
      const messages = await done;

      // Should complete without timeout (step limit prevents runaway)
      const doneMsg = messages.find(
        (m) => m.type === MSG_CHAT_RESPONSE && m.done === true
      );
      expect(doneMsg).toBeDefined();

      await closeWS(ws);
    });
  });

  describe("assembleContext", () => {
    it("converts messages to model format", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectWS("LoopTestAgent", room);

      const agent = await getAgentByName(env.LoopTestAgent, room);
      const rpc = agent as unknown as {
        createSession(n: string): Promise<Session>;
        getMessages(): Promise<UIMessage[]>;
      };
      await rpc.createSession("context-test");
      await collectMessages(ws, 1, 500);

      // Send a message and let it complete
      const done = waitForDone(ws);
      sendChatRequest(ws, "Hello for context test");
      await done;

      // Wait for persistence
      await collectMessages(ws, 1, 2000);

      // Verify messages were persisted correctly
      const msgs = (await rpc.getMessages()) as unknown as UIMessage[];
      expect(msgs.length).toBeGreaterThanOrEqual(2);

      // User message should be present
      const userMsg = msgs.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();
      expect(userMsg!.parts).toBeDefined();

      await closeWS(ws);
    });
  });
});
