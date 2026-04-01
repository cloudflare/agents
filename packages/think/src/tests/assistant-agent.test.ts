import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";

const MSG_CHAT_MESSAGES = "cf_agent_chat_messages";
const MSG_CHAT_REQUEST = "cf_agent_use_chat_request";
const MSG_CHAT_RESPONSE = "cf_agent_use_chat_response";
const MSG_CHAT_CLEAR = "cf_agent_chat_clear";
const MSG_CHAT_CANCEL = "cf_agent_chat_request_cancel";

async function freshAgent(name?: string) {
  return getAgentByName(
    env.TestAssistantAgentAgent,
    name ?? crypto.randomUUID()
  );
}

async function connectWS(room: string) {
  const res = await exports.default.fetch(
    `http://example.com/agents/test-assistant-agent-agent/${room}`,
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

describe("Think — streaming flow", () => {
  it("sends a chat request and receives streamed response", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectWS(room);

    await collectMessages(ws, 3);

    const responsesPromise = collectMessagesOfType(ws, MSG_CHAT_RESPONSE, true);
    const requestId = sendChatRequest(ws, [makeUserMessage("hello")]);
    const responses = await responsesPromise;

    expect(responses.length).toBeGreaterThan(1);
    for (const r of responses) {
      expect(r.id).toBe(requestId);
    }

    const last = responses[responses.length - 1];
    expect(last.done).toBe(true);

    const dataResponses = responses.filter((r) => r.done !== true);
    expect(dataResponses.length).toBeGreaterThan(0);

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

    await collectMessages(ws, 3);

    const responsesPromise = collectMessagesOfType(ws, MSG_CHAT_RESPONSE, true);
    sendChatRequest(ws, [makeUserMessage("hello")]);
    await responsesPromise;

    await waitForMessageOfType(ws, MSG_CHAT_MESSAGES);

    const messages = (await agent.getMessages()) as unknown as UIMessage[];
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");

    const textPart = messages[1].parts.find(
      (p: { type: string }) => p.type === "text"
    ) as { type: string; text: string } | undefined;
    expect(textPart).toBeDefined();
    expect(textPart!.text).toBe("Hello from assistant");

    await closeWS(ws);
  });
});

describe("Think — clear", () => {
  it("clears all messages", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);

    await collectMessages(ws, 3);

    const responsesPromise = collectMessagesOfType(ws, MSG_CHAT_RESPONSE, true);
    sendChatRequest(ws, [makeUserMessage("hello")]);
    await responsesPromise;

    await waitForMessageOfType(ws, MSG_CHAT_MESSAGES);

    let messages = (await agent.getMessages()) as unknown as UIMessage[];
    expect(messages.length).toBe(2);

    const clearPromise = waitForMessageOfType(ws, MSG_CHAT_CLEAR);
    ws.send(JSON.stringify({ type: MSG_CHAT_CLEAR }));
    await clearPromise;

    messages = (await agent.getMessages()) as unknown as UIMessage[];
    expect(messages.length).toBe(0);

    await closeWS(ws);
  });
});

describe("Think — cancel", () => {
  it("cancel message does not crash the agent", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectWS(room);

    await collectMessages(ws, 3);

    ws.send(
      JSON.stringify({
        type: MSG_CHAT_CANCEL,
        id: "non-existent-request"
      })
    );

    const responsesPromise = collectMessagesOfType(ws, MSG_CHAT_RESPONSE, true);
    sendChatRequest(ws, [makeUserMessage("still alive")]);
    const responses = await responsesPromise;

    expect(responses.length).toBeGreaterThan(1);
    const last = responses[responses.length - 1];
    expect(last.done).toBe(true);

    await closeWS(ws);
  });
});

describe("Think — message persistence", () => {
  it("messages survive across agent instances", async () => {
    const room = crypto.randomUUID();

    const agent1 = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    const responsesPromise = collectMessagesOfType(ws, MSG_CHAT_RESPONSE, true);
    sendChatRequest(ws, [makeUserMessage("hello")]);
    await responsesPromise;
    await waitForMessageOfType(ws, MSG_CHAT_MESSAGES);
    await closeWS(ws);

    const messages1 = (await agent1.getMessages()) as unknown as UIMessage[];
    expect(messages1.length).toBe(2);

    const agent2 = await freshAgent(room);
    const messages2 = (await agent2.getMessages()) as unknown as UIMessage[];
    expect(messages2.length).toBe(2);
    expect(messages2[0].role).toBe("user");
    expect(messages2[1].role).toBe("assistant");
  });
});
