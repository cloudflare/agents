/**
 * Issue #1404 — provider replay of prior tool calls during continuation
 * streams must not regress tool part state, must not warn on idempotent
 * re-applies, and must not produce duplicate tool parts in the persisted
 * message.
 *
 * Two layers are exercised:
 *
 * 1. The server's `_streamSSEReply` filters replay tool-input-* chunks
 *    via `isReplayChunk` so they are neither broadcast to clients nor
 *    persisted in the resumable-stream chunk store. (The downstream
 *    AI SDK on the client mutates an existing tool part in place when a
 *    chunk arrives with a matching toolCallId, which would clobber an
 *    `output-available` part back to `input-streaming` if these chunks
 *    were forwarded.)
 *
 * 2. `_applyToolResult` accepts `output-available` / `output-error` as
 *    starting states and short-circuits to a no-op when the incoming
 *    result matches what the part already holds. This handles duplicate
 *    cf_agent_tool_result frames (cross-tab re-runs, WS redelivery)
 *    without the spurious "not in expected state" warn.
 */
import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { MessageType } from "../types";
import type { UIMessage as ChatMessage } from "ai";
import { connectChatWS } from "./test-utils";
import { getAgentByName } from "agents";

function collectMessages(ws: WebSocket): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  ws.addEventListener("message", (e: MessageEvent) => {
    const data = JSON.parse(e.data as string);
    if (typeof data === "object" && data !== null) {
      messages.push(data as Record<string, unknown>);
    }
  });
  return messages;
}

async function waitForMessage(
  messages: Array<Record<string, unknown>>,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs = 3000
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const match = messages.find(predicate);
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return undefined;
}

function getToolPart(
  message: ChatMessage,
  toolCallId: string
): Record<string, unknown> | undefined {
  return message.parts.find(
    (
      part
    ): part is ChatMessage["parts"][number] & {
      toolCallId: string;
    } => "toolCallId" in part && part.toolCallId === toolCallId
  ) as Record<string, unknown> | undefined;
}

describe("Tool result idempotency (issue #1404)", () => {
  it("re-applying the same tool result is a silent no-op (no warn, no broadcast)", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const agentStub = await getAgentByName(env.TestChatAgent, room);

    const userMessage: ChatMessage = {
      id: "msg-idempotent",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    };
    const toolCallId = "call_idempotent_apply";
    const output = { success: true, color: "green" };

    await agentStub.persistMessages([
      userMessage,
      {
        id: "assistant-idempotent",
        role: "assistant",
        parts: [
          {
            type: "tool-changeBackgroundColor",
            toolCallId,
            state: "input-available",
            input: { color: "green" }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    // First apply: legitimate transition input-available → output-available.
    const firstApplied = await agentStub.testApplyToolResult(
      toolCallId,
      "changeBackgroundColor",
      output
    );
    expect(firstApplied).toBe(true);

    // Persisted state has the tool at output-available with the right output.
    {
      const persisted =
        (await agentStub.getPersistedMessages()) as ChatMessage[];
      const tool = getToolPart(
        persisted.find((m) => m.role === "assistant") as ChatMessage,
        toolCallId
      );
      expect(tool?.state).toBe("output-available");
      expect(tool?.output).toEqual(output);
    }

    // Re-collect messages from this point so we only count broadcasts
    // emitted by the second (idempotent) apply.
    const broadcasts = collectMessages(ws);

    // Second apply with the same output — must NOT warn, must NOT
    // broadcast a redundant MESSAGE_UPDATED.
    const secondApplied = await agentStub.testApplyToolResult(
      toolCallId,
      "changeBackgroundColor",
      output
    );
    expect(secondApplied).toBe(true);

    // Give any spurious broadcast a chance to arrive.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const updatedBroadcasts = broadcasts.filter(
      (m) => m.type === MessageType.CF_AGENT_MESSAGE_UPDATED
    );
    expect(updatedBroadcasts).toHaveLength(0);

    // State is still right.
    {
      const persisted =
        (await agentStub.getPersistedMessages()) as ChatMessage[];
      const tool = getToolPart(
        persisted.find((m) => m.role === "assistant") as ChatMessage,
        toolCallId
      );
      expect(tool?.state).toBe("output-available");
      expect(tool?.output).toEqual(output);
    }

    ws.close(1000);
  });

  it("re-applying the same output-error is a silent no-op", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const agentStub = await getAgentByName(env.TestChatAgent, room);

    const userMessage: ChatMessage = {
      id: "msg-idempotent-err",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    };
    const toolCallId = "call_idempotent_apply_err";
    const errorText = "user denied";

    await agentStub.persistMessages([
      userMessage,
      {
        id: "assistant-idempotent-err",
        role: "assistant",
        parts: [
          {
            type: "tool-changeBackgroundColor",
            toolCallId,
            state: "input-available",
            input: { color: "green" }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    expect(
      await agentStub.testApplyToolResult(
        toolCallId,
        "changeBackgroundColor",
        undefined,
        "output-error",
        errorText
      )
    ).toBe(true);

    const broadcasts = collectMessages(ws);

    expect(
      await agentStub.testApplyToolResult(
        toolCallId,
        "changeBackgroundColor",
        undefined,
        "output-error",
        errorText
      )
    ).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 250));
    const updatedBroadcasts = broadcasts.filter(
      (m) => m.type === MessageType.CF_AGENT_MESSAGE_UPDATED
    );
    expect(updatedBroadcasts).toHaveLength(0);

    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const tool = getToolPart(
      persisted.find((m) => m.role === "assistant") as ChatMessage,
      toolCallId
    );
    expect(tool?.state).toBe("output-error");
    expect(tool?.errorText).toBe(errorText);

    ws.close(1000);
  });

  it("legacy duplicate tool parts: real change to one part is still persisted even if another duplicate is already terminal", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const agentStub = await getAgentByName(env.TestChatAgent, room);

    const userMessage: ChatMessage = {
      id: "msg-dup",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    };
    const toolCallId = "call_dup";
    const realOutput = { success: true, color: "green" };

    // Seed a (legacy) message with two parts sharing the same toolCallId:
    // one already at output-available (no-op on re-apply), one still at
    // input-available (must transition on apply).
    await agentStub.persistMessages([
      userMessage,
      {
        id: "assistant-dup",
        role: "assistant",
        parts: [
          {
            type: "tool-changeBackgroundColor",
            toolCallId,
            state: "output-available",
            input: { color: "green" },
            output: { success: true, color: "green-old" }
          },
          {
            type: "tool-changeBackgroundColor",
            toolCallId,
            state: "input-available",
            input: { color: "green" }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    expect(
      await agentStub.testApplyToolResult(
        toolCallId,
        "changeBackgroundColor",
        realOutput
      )
    ).toBe(true);

    // The terminal-state duplicate must be preserved (first-write-wins),
    // and the input-available duplicate must transition to output-available.
    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = persisted.filter((m) => m.role === "assistant");
    const allToolParts = assistantMessages.flatMap((m) =>
      m.parts.filter((p) => "toolCallId" in p && p.toolCallId === toolCallId)
    ) as Array<Record<string, unknown>>;

    expect(allToolParts).toHaveLength(2);
    // Original terminal part untouched (first-write-wins).
    expect(allToolParts[0].state).toBe("output-available");
    expect(allToolParts[0].output).toEqual({
      success: true,
      color: "green-old"
    });
    // Previously-non-terminal part transitioned to output-available
    // with the new output.
    expect(allToolParts[1].state).toBe("output-available");
    expect(allToolParts[1].output).toEqual(realOutput);

    ws.close(1000);
  });

  it("legitimate transition still broadcasts (regression guard for the no-op detection)", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const agentStub = await getAgentByName(env.TestChatAgent, room);

    const userMessage: ChatMessage = {
      id: "msg-broadcast",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    };
    const toolCallId = "call_first_apply_broadcast";
    const output = { success: true };

    await agentStub.persistMessages([
      userMessage,
      {
        id: "assistant-broadcast",
        role: "assistant",
        parts: [
          {
            type: "tool-changeBackgroundColor",
            toolCallId,
            state: "input-available",
            input: { color: "blue" }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    const broadcasts = collectMessages(ws);

    expect(
      await agentStub.testApplyToolResult(
        toolCallId,
        "changeBackgroundColor",
        output
      )
    ).toBe(true);

    const update = (await waitForMessage(
      broadcasts,
      (m) => m.type === MessageType.CF_AGENT_MESSAGE_UPDATED
    )) as { message: ChatMessage } | undefined;
    expect(update).toBeDefined();
    const tool = getToolPart(update!.message, toolCallId);
    expect(tool?.state).toBe("output-available");
    expect(tool?.output).toEqual(output);

    ws.close(1000);
  });
});

describe("Tool replay chunks during continuation (issue #1404)", () => {
  it("replayed tool-input-*/tool-output-available chunks are not forwarded to clients", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const agentStub = await getAgentByName(env.TestChatAgent, room);

    const userMessage: ChatMessage = {
      id: "msg-replay",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    };
    const toolCallId = "call_replay";
    const toolName = "changeBackgroundColor";
    const input = { color: "green" };
    const output = { success: true };

    // Drive an initial chat turn so the request body — including the
    // replay knobs — gets persisted as the auto-continuation body.
    {
      let resolveInitialDone: (value: boolean) => void;
      const initialDonePromise = new Promise<boolean>((res) => {
        resolveInitialDone = res;
      });
      const initialTimeout = setTimeout(() => resolveInitialDone(false), 3000);
      ws.addEventListener("message", function initialHandler(e: MessageEvent) {
        const data = JSON.parse(e.data as string);
        if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
          clearTimeout(initialTimeout);
          resolveInitialDone(true);
          ws.removeEventListener("message", initialHandler);
        }
      });
      ws.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
          id: "req-replay",
          init: {
            method: "POST",
            body: JSON.stringify({
              messages: [userMessage],
              replayPriorToolCall: true,
              replayToolCallId: toolCallId,
              replayToolName: toolName,
              replayInput: input,
              replayOutput: output
            })
          }
        })
      );
      const ok = await initialDonePromise;
      expect(ok).toBe(true);
    }

    // Seed an assistant message that already has the tool at output-available
    // — this is what the cloned _streamingMessage will look like when the
    // continuation begins.
    await agentStub.persistMessages([
      userMessage,
      {
        id: "assistant-replay",
        role: "assistant",
        parts: [
          {
            type: `tool-${toolName}`,
            toolCallId,
            state: "output-available",
            input,
            output
          }
        ] as ChatMessage["parts"]
      }
    ]);

    const receivedMessages = collectMessages(ws);

    // Trigger the continuation by re-sending the (already-applied)
    // tool result with autoContinue. The continuation will hit the
    // replayPriorToolCall branch in onChatMessage and emit the
    // tool-input-start → delta → available → output-available
    // sequence. With the issue #1404 fix those replay chunks must
    // not be forwarded as CF_AGENT_USE_CHAT_RESPONSE bodies.
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_TOOL_RESULT,
        toolCallId,
        toolName,
        output,
        autoContinue: true
      })
    );

    // Wait for the continuation stream to finish.
    const doneMessage = await waitForMessage(
      receivedMessages,
      (m) =>
        m.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
        m.done === true &&
        m.continuation === true,
      5000
    );
    expect(doneMessage).toBeDefined();

    // Inspect every chunk body broadcast during the continuation.
    const replayTypes = ["tool-input-start", "tool-input-delta"];
    const forwardedReplayChunks = receivedMessages
      .filter(
        (m) =>
          m.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
          typeof m.body === "string" &&
          (m as { body: string }).body.length > 0
      )
      .map((m) => {
        try {
          return JSON.parse((m as { body: string }).body) as Record<
            string,
            unknown
          >;
        } catch {
          return null;
        }
      })
      .filter((chunk): chunk is Record<string, unknown> => chunk != null)
      .filter(
        (chunk) =>
          replayTypes.includes(chunk.type as string) &&
          chunk.toolCallId === toolCallId
      );

    expect(forwardedReplayChunks).toHaveLength(0);

    // tool-input-available for the same toolCallId must also be filtered
    // (it's a replay since the part is already past input-streaming).
    const forwardedInputAvailable = receivedMessages
      .filter(
        (m) =>
          m.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
          typeof m.body === "string"
      )
      .map((m) => {
        try {
          return JSON.parse((m as { body: string }).body) as Record<
            string,
            unknown
          >;
        } catch {
          return null;
        }
      })
      .filter((chunk): chunk is Record<string, unknown> => chunk != null)
      .filter(
        (chunk) =>
          chunk.type === "tool-input-available" &&
          chunk.toolCallId === toolCallId
      );

    expect(forwardedInputAvailable).toHaveLength(0);

    // The persisted message must still have exactly one tool part for
    // this toolCallId, in output-available, with the original output.
    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = persisted.filter((m) => m.role === "assistant");
    const allToolPartsForCall = assistantMessages.flatMap((m) =>
      m.parts.filter((p) => "toolCallId" in p && p.toolCallId === toolCallId)
    );
    expect(allToolPartsForCall).toHaveLength(1);
    const tool = allToolPartsForCall[0] as Record<string, unknown>;
    expect(tool.state).toBe("output-available");
    expect(tool.output).toEqual(output);
    expect(tool.input).toEqual(input);

    ws.close(1000);
  });
});
