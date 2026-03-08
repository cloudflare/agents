import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "./worker";
import worker from "./worker";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";
import type { Session } from "../session/index";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// ── Wire protocol constants (must match agent.ts) ─────────────────
const MSG_CHAT_MESSAGES = "cf_agent_chat_messages";
const MSG_CHAT_REQUEST = "cf_agent_use_chat_request";
const MSG_CHAT_RESPONSE = "cf_agent_use_chat_response";
const MSG_CHAT_CLEAR = "cf_agent_chat_clear";
const MSG_CHAT_CANCEL = "cf_agent_chat_request_cancel";

// ── Helpers ────────────────────────────────────────────────────────

async function freshAgent(name?: string) {
  return getAgentByName(
    env.TestAssistantAgentAgent,
    name ?? crypto.randomUUID()
  );
}

async function connectWS(room: string) {
  const ctx = createExecutionContext();
  const req = new Request(
    `http://example.com/agents/test-assistant-agent-agent/${room}`,
    { headers: { Upgrade: "websocket" } }
  );
  const res = await worker.fetch(req, env, ctx);
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return { ws, ctx };
}

function collectMessages(
  ws: WebSocket,
  count: number,
  timeout = 3000
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

function waitForMessageOfType(
  ws: WebSocket,
  type: string,
  timeout = 3000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for ${type}`)),
      timeout
    );
    const handler = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as Record<string, unknown>;
        if (msg.type === type) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve(msg);
        }
      } catch {
        // ignore
      }
    };
    ws.addEventListener("message", handler);
  });
}

function collectMessagesOfType(
  ws: WebSocket,
  type: string,
  untilDone: boolean,
  timeout = 3000
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const messages: Array<Record<string, unknown>> = [];
    const timer = setTimeout(() => resolve(messages), timeout);
    const handler = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as Record<string, unknown>;
        if (msg.type === type) {
          messages.push(msg);
          if (untilDone && msg.done === true) {
            clearTimeout(timer);
            ws.removeEventListener("message", handler);
            resolve(messages);
          }
        }
      } catch {
        // ignore
      }
    };
    ws.addEventListener("message", handler);
  });
}

function sendChatRequest(
  ws: WebSocket,
  messages: UIMessage[],
  requestId?: string
) {
  const id = requestId ?? crypto.randomUUID();
  ws.send(
    JSON.stringify({
      type: MSG_CHAT_REQUEST,
      id,
      init: {
        method: "POST",
        body: JSON.stringify({ messages })
      }
    })
  );
  return id;
}

function makeUserMessage(text: string): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text }]
  };
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

// ── Tests ──────────────────────────────────────────────────────────

describe("AssistantAgent — session management", () => {
  it("starts with no sessions", async () => {
    const agent = await freshAgent();
    const sessions = (await agent.getSessions()) as unknown as Session[];
    expect(sessions.length).toBe(0);
  });

  it("creates a session and sets it as current", async () => {
    const agent = await freshAgent();
    const session = (await agent.createSession(
      "test chat"
    )) as unknown as Session;
    expect(session.name).toBe("test chat");

    const currentId = (await agent.getCurrentSessionId()) as unknown as string;
    expect(currentId).toBe(session.id);
  });

  it("lists multiple sessions", async () => {
    const agent = await freshAgent();
    await agent.createSession("chat 1");
    await agent.createSession("chat 2");

    const sessions = (await agent.getSessions()) as unknown as Session[];
    expect(sessions.length).toBe(2);
  });

  it("switches sessions and loads history", async () => {
    const agent = await freshAgent();
    const s1 = (await agent.createSession("session 1")) as unknown as Session;
    const s2 = (await agent.createSession("session 2")) as unknown as Session;

    // Current should be s2 (last created)
    let currentId = (await agent.getCurrentSessionId()) as unknown as string;
    expect(currentId).toBe(s2.id);

    // Switch back to s1
    const messages = (await agent.switchSession(
      s1.id
    )) as unknown as UIMessage[];
    expect(messages).toEqual([]);

    currentId = (await agent.getCurrentSessionId()) as unknown as string;
    expect(currentId).toBe(s1.id);
  });

  it("deletes a session", async () => {
    const agent = await freshAgent();
    const session = (await agent.createSession(
      "to delete"
    )) as unknown as Session;

    await agent.deleteSession(session.id);

    const sessions = (await agent.getSessions()) as unknown as Session[];
    expect(sessions.length).toBe(0);

    // Current session should be null
    const currentId = await agent.getCurrentSessionId();
    expect(currentId).toBeNull();
  });

  it("renames a session", async () => {
    const agent = await freshAgent();
    const session = (await agent.createSession(
      "old name"
    )) as unknown as Session;

    await agent.renameSession(session.id, "new name");

    const sessions = (await agent.getSessions()) as unknown as Session[];
    expect(sessions[0].name).toBe("new name");
  });
});

describe("AssistantAgent — message persistence", () => {
  it("messages are empty for a new session", async () => {
    const agent = await freshAgent();
    await agent.createSession("empty chat");

    const messages = (await agent.getMessages()) as unknown as UIMessage[];
    expect(messages.length).toBe(0);
  });

  it("getSessionHistory returns history for a session", async () => {
    const agent = await freshAgent();
    const session = (await agent.createSession("test")) as unknown as Session;

    // Session history should be empty
    const history = (await agent.getSessionHistory(
      session.id
    )) as unknown as UIMessage[];
    expect(history.length).toBe(0);
  });
});

describe("AssistantAgent — session recovery", () => {
  it("recovers current session ID across agent instances", async () => {
    const name = crypto.randomUUID();

    // First instance — create a session
    const agent1 = await freshAgent(name);
    const session = (await agent1.createSession(
      "persistent"
    )) as unknown as Session;

    // Second instance with same name — should recover session
    const agent2 = await freshAgent(name);
    const currentId = (await agent2.getCurrentSessionId()) as unknown as string;
    expect(currentId).toBe(session.id);

    const sessions = (await agent2.getSessions()) as unknown as Session[];
    expect(sessions.length).toBe(1);
    expect(sessions[0].name).toBe("persistent");
  });
});

describe("AssistantAgent — streaming flow", () => {
  it("sends a chat request and receives streamed response", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectWS(room);

    // Skip initial messages (identity, state, mcp_servers)
    await collectMessages(ws, 3);

    // Collect chat responses until done
    const responsesPromise = collectMessagesOfType(ws, MSG_CHAT_RESPONSE, true);

    // Send a chat request
    const requestId = sendChatRequest(ws, [makeUserMessage("hello")]);

    const responses = await responsesPromise;

    // Should have received multiple chunks + final done
    expect(responses.length).toBeGreaterThan(1);

    // All responses should have our requestId
    for (const r of responses) {
      expect(r.id).toBe(requestId);
    }

    // Last response should be done
    const last = responses[responses.length - 1];
    expect(last.done).toBe(true);

    // Non-done responses should contain body with parsed events
    const dataResponses = responses.filter((r) => r.done !== true);
    expect(dataResponses.length).toBeGreaterThan(0);

    // Verify the text content was streamed
    const bodies = dataResponses
      .map((r) => {
        try {
          return JSON.parse(r.body as string) as {
            type: string;
            delta?: string;
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const deltas = bodies
      .filter((b) => b!.type === "text-delta")
      .map((b) => b!.delta);
    expect(deltas.join("")).toBe("Hello from assistant");

    await closeWS(ws);
  });

  it("persists assistant message after streaming", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);

    // Skip initial messages
    await collectMessages(ws, 3);

    // Wait for response to complete
    const responsesPromise = collectMessagesOfType(ws, MSG_CHAT_RESPONSE, true);
    sendChatRequest(ws, [makeUserMessage("hello")]);
    await responsesPromise;

    // Also wait for the messages broadcast after persistence
    await waitForMessageOfType(ws, MSG_CHAT_MESSAGES);

    // Check persisted messages via RPC
    const messages = (await agent.getMessages()) as unknown as UIMessage[];
    // Should have user message + assistant message
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");

    // Assistant message should contain the streamed text
    const textPart = messages[1].parts.find(
      (p: { type: string }) => p.type === "text"
    ) as { type: string; text: string } | undefined;
    expect(textPart).toBeDefined();
    expect(textPart!.text).toBe("Hello from assistant");

    await closeWS(ws);
  });

  it("auto-creates a session on first chat message", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);

    // Skip initial messages
    await collectMessages(ws, 3);

    // No session should exist yet
    let sessions = (await agent.getSessions()) as unknown as Session[];
    expect(sessions.length).toBe(0);

    // Send a chat request — should auto-create a session
    const responsesPromise = collectMessagesOfType(ws, MSG_CHAT_RESPONSE, true);
    sendChatRequest(ws, [makeUserMessage("hello")]);
    await responsesPromise;

    // Wait for message broadcast
    await waitForMessageOfType(ws, MSG_CHAT_MESSAGES);

    // Session should now exist
    sessions = (await agent.getSessions()) as unknown as Session[];
    expect(sessions.length).toBe(1);
    expect(sessions[0].name).toBe("New Chat");

    // Current session should be set
    const currentId = (await agent.getCurrentSessionId()) as unknown as string;
    expect(currentId).toBe(sessions[0].id);

    await closeWS(ws);
  });
});

describe("AssistantAgent — clear", () => {
  it("clears messages but preserves the session", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);

    // Skip initial messages
    await collectMessages(ws, 3);

    // Send a chat request to generate messages
    const responsesPromise = collectMessagesOfType(ws, MSG_CHAT_RESPONSE, true);
    sendChatRequest(ws, [makeUserMessage("hello")]);
    await responsesPromise;

    // Wait for message broadcast
    await waitForMessageOfType(ws, MSG_CHAT_MESSAGES);

    // Verify messages exist
    let messages = (await agent.getMessages()) as unknown as UIMessage[];
    expect(messages.length).toBe(2);

    // Get current session ID before clear
    const sessionId = (await agent.getCurrentSessionId()) as unknown as string;
    expect(sessionId).toBeTruthy();

    // Send clear
    const clearPromise = waitForMessageOfType(ws, MSG_CHAT_CLEAR);
    ws.send(JSON.stringify({ type: MSG_CHAT_CLEAR }));
    await clearPromise;

    // Messages should be empty
    messages = (await agent.getMessages()) as unknown as UIMessage[];
    expect(messages.length).toBe(0);

    // Session should still exist with the same ID
    const currentId = (await agent.getCurrentSessionId()) as unknown as string;
    expect(currentId).toBe(sessionId);

    // Session should still be in the list
    const sessions = (await agent.getSessions()) as unknown as Session[];
    expect(sessions.length).toBe(1);

    await closeWS(ws);
  });
});

describe("AssistantAgent — cancel", () => {
  it("cancel message does not crash the agent", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectWS(room);

    // Skip initial messages
    await collectMessages(ws, 3);

    // Send a cancel for a non-existent request (should be a no-op)
    ws.send(
      JSON.stringify({
        type: MSG_CHAT_CANCEL,
        id: "non-existent-request"
      })
    );

    // Agent should still be alive — send a chat request
    const responsesPromise = collectMessagesOfType(ws, MSG_CHAT_RESPONSE, true);
    sendChatRequest(ws, [makeUserMessage("still alive")]);
    const responses = await responsesPromise;

    // Should get a normal response
    expect(responses.length).toBeGreaterThan(1);
    const last = responses[responses.length - 1];
    expect(last.done).toBe(true);

    await closeWS(ws);
  });
});

describe("AssistantAgent — multi-session isolation", () => {
  it("messages do not bleed between sessions", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);

    // Skip initial messages (identity, state, mcp_servers)
    await collectMessages(ws, 3);

    // Create session 1 via RPC (broadcast fires synchronously, just drain)
    const s1 = (await agent.createSession("session 1")) as unknown as Session;
    await collectMessages(ws, 1, 500);

    // Send a chat message in session 1
    const r1 = collectMessagesOfType(ws, MSG_CHAT_RESPONSE, true);
    sendChatRequest(ws, [makeUserMessage("message in session 1")]);
    await r1;

    // Drain post-persistence broadcast
    await collectMessages(ws, 1, 500);

    // Session 1 should have 2 messages (user + assistant)
    const s1History = (await agent.getSessionHistory(
      s1.id
    )) as unknown as UIMessage[];
    expect(s1History.length).toBe(2);

    // Create session 2 via RPC (switches away from session 1)
    const s2 = (await agent.createSession("session 2")) as unknown as Session;
    await collectMessages(ws, 1, 500);

    // Send a chat message in session 2
    const r2 = collectMessagesOfType(ws, MSG_CHAT_RESPONSE, true);
    sendChatRequest(ws, [makeUserMessage("message in session 2")]);
    await r2;

    // Drain post-persistence broadcast
    await collectMessages(ws, 1, 500);

    // Session 2 should have 2 messages
    const s2History = (await agent.getSessionHistory(
      s2.id
    )) as unknown as UIMessage[];
    expect(s2History.length).toBe(2);

    // Session 1 should still have exactly 2 messages (no bleed)
    const s1HistoryAfter = (await agent.getSessionHistory(
      s1.id
    )) as unknown as UIMessage[];
    expect(s1HistoryAfter.length).toBe(2);

    // Verify content is distinct
    const s1Text = (s1HistoryAfter[0].parts[0] as { text: string }).text;
    const s2Text = (s2History[0].parts[0] as { text: string }).text;
    expect(s1Text).toBe("message in session 1");
    expect(s2Text).toBe("message in session 2");

    await closeWS(ws);
  });

  it("clearMessages only clears the current session", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);

    // Skip initial messages
    await collectMessages(ws, 3);

    // Create session 1 and send a message
    const s1 = (await agent.createSession("session 1")) as unknown as Session;
    await collectMessages(ws, 1, 500);

    const cr1 = collectMessagesOfType(ws, MSG_CHAT_RESPONSE, true);
    sendChatRequest(ws, [makeUserMessage("s1 msg")]);
    await cr1;
    await collectMessages(ws, 1, 500);

    // Create session 2 and send a message
    const s2 = (await agent.createSession("session 2")) as unknown as Session;
    await collectMessages(ws, 1, 500);

    const cr2 = collectMessagesOfType(ws, MSG_CHAT_RESPONSE, true);
    sendChatRequest(ws, [makeUserMessage("s2 msg")]);
    await cr2;
    await collectMessages(ws, 1, 500);

    // Current is s2. Clear it via RPC.
    await agent.clearCurrentSessionMessages();

    // Session 2 should be empty
    const s2History = (await agent.getSessionHistory(
      s2.id
    )) as unknown as UIMessage[];
    expect(s2History.length).toBe(0);

    // Session 1 should be untouched
    const s1History = (await agent.getSessionHistory(
      s1.id
    )) as unknown as UIMessage[];
    expect(s1History.length).toBe(2);

    await closeWS(ws);
  });
});
