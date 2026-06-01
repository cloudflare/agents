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
    // The interrupted orphan is PRESERVED (not deleted) and flipped to an
    // errored result: the record survives in the transcript (no "disappearing"
    // tool call) while the synthesized tool-result keeps the provider from
    // 400ing (AI_MissingToolResultsError).
    const orphan = messages.find(
      (message) => message.id === "orphan-assistant"
    );
    expect(orphan).toBeDefined();
    const orphanToolPart = orphan!.parts.find((part) =>
      (
        (part as Record<string, unknown>).type as string | undefined
      )?.startsWith("tool-")
    ) as Record<string, unknown> | undefined;
    expect(orphanToolPart?.state).toBe("output-error");
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

  it("parses a stringified ARRAY tool input back into structured form", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const ws = await connectWS(room);

    await agent.setTextOnlyMode(true);

    const userA = makeUserMessage("user-a", "batch these");
    const assistantArrayInput: UIMessage = {
      id: "assistant-array-input",
      role: "assistant",
      parts: [
        {
          type: "tool-batch",
          toolCallId: TOOL_CALL_ID,
          state: "output-available",
          input: '[{"id":1},{"id":2}]',
          output: { ok: true }
        } as unknown as UIMessage["parts"][number]
      ]
    };
    await agent.persistToolCallMessage([userA, assistantArrayInput]);

    const responsePromise = waitForChatResponse(ws);
    sendChatRequest(ws, [makeUserMessage("user-b", "continue")]);
    const response = await responsePromise;

    expect(response.done).toBe(true);
    expect(response.error).toBeUndefined();

    const messages = (await agent.getMessages()) as UIMessage[];
    const repaired = messages.find((m) => m.id === assistantArrayInput.id);
    const toolPart = repaired!.parts.find(
      (part) => (part as Record<string, unknown>).toolCallId === TOOL_CALL_ID
    ) as Record<string, unknown> | undefined;
    expect(toolPart?.input).toEqual([{ id: 1 }, { id: 2 }]);

    ws.close(1000);
  });

  it("defaults a missing tool input to an empty object so the provider does not 400", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const ws = await connectWS(room);

    await agent.setTextOnlyMode(true);

    const userA = makeUserMessage("user-a", "create a cat");
    // A settled tool call whose `input` was lost (provider-executed tool, a
    // racey persist, etc.). Anthropic rejects a tool_use block with no input,
    // so repair must default it to `{}` rather than leave it unrepaired.
    const assistantMissingInput: UIMessage = {
      id: "assistant-missing-input",
      role: "assistant",
      parts: [
        {
          type: "tool-generateImage",
          toolCallId: TOOL_CALL_ID,
          state: "output-available",
          output: { url: "https://example.test/cat.png" }
        } as unknown as UIMessage["parts"][number]
      ]
    };
    await agent.persistToolCallMessage([userA, assistantMissingInput]);

    const responsePromise = waitForChatResponse(ws);
    sendChatRequest(ws, [makeUserMessage("user-b", "continue")]);
    const response = await responsePromise;

    expect(response.done).toBe(true);
    expect(response.error).toBeUndefined();

    const messages = (await agent.getMessages()) as UIMessage[];
    const repaired = messages.find(
      (message) => message.id === assistantMissingInput.id
    );
    expect(repaired).toBeDefined();
    const toolPart = repaired!.parts.find(
      (part) => (part as Record<string, unknown>).toolCallId === TOOL_CALL_ID
    ) as Record<string, unknown> | undefined;
    expect(toolPart?.input).toEqual({});

    ws.close(1000);
  });

  it("does not re-repair an already-errored tool call or clobber its errorText", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const ws = await connectWS(room);

    await agent.setTextOnlyMode(true);

    const userA = makeUserMessage("user-a", "create a cat");
    // A tool that legitimately errored: state `output-error` with a real
    // message and NO `output` field. Repair must treat `output-error` as
    // settled — otherwise it re-flips the part every turn, clobbering the real
    // errorText with the generic "interrupted" message and emitting spurious
    // repair events/writes/broadcasts for the life of the conversation.
    const REAL_ERROR = "Image provider rejected the prompt (content policy).";
    const assistantErrored: UIMessage = {
      id: "assistant-errored",
      role: "assistant",
      parts: [
        {
          type: "tool-generateImage",
          toolCallId: TOOL_CALL_ID,
          state: "output-error",
          input: { prompt: "a cat" },
          errorText: REAL_ERROR
        } as unknown as UIMessage["parts"][number]
      ]
    };
    await agent.persistToolCallMessage([userA, assistantErrored]);

    const responsePromise = waitForChatResponse(ws);
    sendChatRequest(ws, [makeUserMessage("user-b", "continue")]);
    const response = await responsePromise;

    expect(response.done).toBe(true);
    expect(response.error).toBeUndefined();

    const messages = (await agent.getMessages()) as UIMessage[];
    const errored = messages.find((m) => m.id === assistantErrored.id);
    expect(errored).toBeDefined();
    const toolPart = errored!.parts.find(
      (part) => (part as Record<string, unknown>).toolCallId === TOOL_CALL_ID
    ) as Record<string, unknown> | undefined;
    expect(toolPart?.state).toBe("output-error");
    // The real error survives — repair did not re-flip it to the generic text.
    expect(toolPart?.errorText).toBe(REAL_ERROR);

    ws.close(1000);
  });

  it("preserves a denied tool approval (output-denied) instead of flipping it to errored", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const ws = await connectWS(room);

    await agent.setTextOnlyMode(true);

    const userA = makeUserMessage("user-a", "delete everything");
    // A user-denied tool approval. `output-denied` is a settled terminal state
    // the provider accepts (convertToModelMessages turns it into a denial
    // tool-result), so repair must NOT flip it to `output-error` — doing so
    // loses the denial and mislabels it as "interrupted".
    const assistantDenied: UIMessage = {
      id: "assistant-denied",
      role: "assistant",
      parts: [
        {
          type: "tool-deleteFiles",
          toolCallId: TOOL_CALL_ID,
          state: "output-denied",
          input: { path: "/" },
          approval: { id: "appr-1", approved: false, reason: "Too dangerous" }
        } as unknown as UIMessage["parts"][number]
      ]
    };
    await agent.persistToolCallMessage([userA, assistantDenied]);

    const responsePromise = waitForChatResponse(ws);
    sendChatRequest(ws, [makeUserMessage("user-b", "continue")]);
    const response = await responsePromise;

    expect(response.done).toBe(true);
    expect(response.error).toBeUndefined();

    const messages = (await agent.getMessages()) as UIMessage[];
    const denied = messages.find((m) => m.id === assistantDenied.id);
    expect(denied).toBeDefined();
    const toolPart = denied!.parts.find(
      (part) => (part as Record<string, unknown>).toolCallId === TOOL_CALL_ID
    ) as Record<string, unknown> | undefined;
    expect(toolPart?.state).toBe("output-denied");

    ws.close(1000);
  });
});
