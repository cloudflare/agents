/**
 * Regression tests for issue #1381: a concurrent user submit during a
 * streaming tool turn must not produce a duplicate orphan assistant in
 * the session.
 *
 * The client (`useAgentChat`) ships the entire local message list on
 * every send, including the in-flight assistant snapshot it minted
 * optimistically. That snapshot has a client-generated ID, while the
 * server eventually persists the real assistant under a different
 * (server-generated) ID. Without reconciliation, Session's
 * INSERT-OR-IGNORE-by-ID would keep both rows side-by-side, producing
 * two assistant messages with the same `toolCallId` — one orphaned at
 * `state: "input-available"`, one with the real `output-available`
 * payload. The next turn's `convertToModelMessages` then emits a
 * malformed Anthropic prompt and the provider rejects it.
 */

import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";

const MSG_CHAT_REQUEST = "cf_agent_use_chat_request";
const MSG_CHAT_RESPONSE = "cf_agent_use_chat_response";

async function freshAgent(name: string) {
  return getAgentByName(env.ThinkClientToolsAgent, name);
}

async function connectWS(room: string) {
  const res = await exports.default.fetch(
    `http://example.com/agents/think-client-tools-agent/${room}`,
    { headers: { Upgrade: "websocket" } }
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return ws;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForDone(ws: WebSocket, timeout = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timeout waiting for done")),
      timeout
    );
    const handler = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as Record<string, unknown>;
        if (msg.type === MSG_CHAT_RESPONSE && msg.done === true) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve();
        }
      } catch {
        // ignore
      }
    };
    ws.addEventListener("message", handler);
  });
}

function waitForChatResponse(
  ws: WebSocket,
  timeout = 10_000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timeout waiting for chat response")),
      timeout
    );
    const handler = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as Record<string, unknown>;
        if (msg.type === MSG_CHAT_RESPONSE && msg.done === true) {
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

function sendChatRequest(
  ws: WebSocket,
  messages: UIMessage[],
  extra?: Record<string, unknown>
): string {
  const id = crypto.randomUUID();
  ws.send(
    JSON.stringify({
      type: MSG_CHAT_REQUEST,
      id,
      init: {
        method: "POST",
        body: JSON.stringify({ messages, ...extra })
      }
    })
  );
  return id;
}

function makeUserMessage(id: string, text: string): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }]
  };
}

const TOOL_CALL_ID = "toolu_01concurrent_repro";

function makeServerToolAssistant(id: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-generateImage",
        toolCallId: TOOL_CALL_ID,
        state: "output-available",
        input: { prompt: "a cat" },
        output: { url: "https://example.test/cat.png" }
      } as unknown as UIMessage["parts"][number]
    ]
  };
}

function makeClientOptimisticAssistant(id: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      { type: "step-start" } as unknown as UIMessage["parts"][number],
      {
        type: "tool-generateImage",
        toolCallId: TOOL_CALL_ID,
        state: "input-available",
        input: { prompt: "a cat" }
      } as unknown as UIMessage["parts"][number]
    ]
  };
}

function assistantToolPart(
  msg: UIMessage
): { toolCallId: string; state: string } | null {
  for (const part of msg.parts) {
    if ("toolCallId" in part && part.toolCallId) {
      return {
        toolCallId: part.toolCallId as string,
        state: (part as { state?: string }).state ?? ""
      };
    }
  }
  return null;
}

describe("Think — message reconciliation on incoming submits", () => {
  it("collapses a client's optimistic in-flight assistant into the existing server-owned row", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const ws = await connectWS(room);

    await agent.setTextOnlyMode(true);

    // Seed: a complete tool-call assistant already persisted server-side
    // (this is the state the bug repro reaches once the slow tool
    //  finishes and `_persistAssistantMessage` writes the canonical
    //  assistant row).
    const userA = makeUserMessage("user-a", "create a cat");
    const serverAssistantId = "server-cat-assistant";
    const serverAsst = makeServerToolAssistant(serverAssistantId);
    await agent.persistToolCallMessage([userA, serverAsst]);

    // Now the client submits a follow-up while still believing the tool
    // is in-flight: it ships [userA, optimistic-assistant, userB]. The
    // optimistic snapshot carries a client-generated ID and a stale
    // input-available state for the same toolCallId.
    const optimistic = makeClientOptimisticAssistant("client-optimistic");
    const userB = makeUserMessage("user-b", "create a dog");

    const done = waitForDone(ws);
    sendChatRequest(ws, [userA, optimistic, userB]);
    await done;
    await delay(200);

    const messages = (await agent.getMessages()) as UIMessage[];

    // Expected: userA, serverAsst (id preserved), userB, new model
    // response. Pre-fix this had 5 rows because the optimistic snapshot
    // got persisted as an orphan alongside `serverAsst`.
    expect(messages).toHaveLength(4);
    expect(messages[0].id).toBe(userA.id);

    const assistantsWithTool = messages.filter((m) => {
      if (m.role !== "assistant") return false;
      const part = assistantToolPart(m);
      return part?.toolCallId === TOOL_CALL_ID;
    });

    expect(assistantsWithTool).toHaveLength(1);
    expect(assistantsWithTool[0].id).toBe(serverAssistantId);
    expect(assistantToolPart(assistantsWithTool[0])?.state).toBe(
      "output-available"
    );

    // The client's optimistic ID must not have leaked into the session
    // as an additional row.
    expect(messages.map((m) => m.id)).not.toContain("client-optimistic");

    ws.close(1000);
  });

  it("merges server tool outputs into a stale client snapshot when IDs match", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const ws = await connectWS(room);

    await agent.setTextOnlyMode(true);

    // Seed: the server has the same assistant id the client knows
    // about, but at output-available state. The client posts its stale
    // input-available copy; reconciliation should upgrade it from the
    // server row instead of overwriting the server's tool output.
    const userA = makeUserMessage("user-a", "create a cat");
    const sharedAssistantId = "shared-asst-id";
    await agent.persistToolCallMessage([
      userA,
      makeServerToolAssistant(sharedAssistantId)
    ]);

    const stale = makeClientOptimisticAssistant(sharedAssistantId);
    const userB = makeUserMessage("user-b", "create a dog");

    const done = waitForDone(ws);
    sendChatRequest(ws, [userA, stale, userB]);
    await done;
    await delay(200);

    const messages = (await agent.getMessages()) as UIMessage[];
    const sharedAsst = messages.find((m) => m.id === sharedAssistantId);
    expect(sharedAsst).toBeDefined();
    expect(assistantToolPart(sharedAsst!)).toMatchObject({
      toolCallId: TOOL_CALL_ID,
      state: "output-available"
    });

    ws.close(1000);
  });

  it("repairs a persisted orphan tool call before the next Think turn", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const ws = await connectWS(room);

    await agent.setTextOnlyMode(true);

    const userA = makeUserMessage("user-a", "create a cat");
    const orphanAssistant = makeClientOptimisticAssistant("orphan-assistant");
    await agent.persistToolCallMessage([userA, orphanAssistant]);

    const responsePromise = waitForChatResponse(ws);
    sendChatRequest(ws, [makeUserMessage("user-b", "continue")]);
    const response = await responsePromise;

    expect(response.done).toBe(true);
    expect(response.error).toBeUndefined();

    const responseLog = (await agent.getResponseLog()) as Array<{
      status: string;
      error?: string;
    }>;
    const lastResponse = responseLog[responseLog.length - 1];
    expect(lastResponse).toMatchObject({ status: "completed" });

    const messages = (await agent.getMessages()) as UIMessage[];
    expect(messages.map((message) => message.id)).not.toContain(
      "orphan-assistant"
    );
    expect(messages.some((message) => message.id === "user-b")).toBe(true);

    ws.close(1000);
  });

  it("persists normalized tool inputs when repair only changes part contents", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const ws = await connectWS(room);

    await agent.setTextOnlyMode(true);

    const userA = makeUserMessage("user-a", "create a cat");
    const assistantWithStringInput: UIMessage = {
      id: "assistant-string-input",
      role: "assistant",
      parts: [
        {
          type: "tool-generateImage",
          toolCallId: TOOL_CALL_ID,
          state: "output-available",
          input: '{"prompt":"a cat"}',
          output: { url: "https://example.test/cat.png" }
        } as unknown as UIMessage["parts"][number]
      ]
    };
    await agent.persistToolCallMessage([userA, assistantWithStringInput]);

    const responsePromise = waitForChatResponse(ws);
    sendChatRequest(ws, [makeUserMessage("user-b", "continue")]);
    const response = await responsePromise;

    expect(response.done).toBe(true);
    expect(response.error).toBeUndefined();

    const messages = (await agent.getMessages()) as UIMessage[];
    const repairedAssistant = messages.find(
      (message) => message.id === assistantWithStringInput.id
    );
    expect(repairedAssistant).toBeDefined();
    const toolPart = repairedAssistant!.parts.find(
      (part) => (part as Record<string, unknown>).toolCallId === TOOL_CALL_ID
    ) as Record<string, unknown> | undefined;
    expect(toolPart?.input).toEqual({ prompt: "a cat" });

    ws.close(1000);
  });
});
