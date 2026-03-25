import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { UIMessage as ChatMessage } from "ai";
import { getAgentByName } from "agents";
import { MessageType } from "../types";
import { connectChatWS } from "./test-utils";

function makeProviderExecutedMessage(id: string): ChatMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-code_execution",
        toolCallId: `${id}-tool`,
        toolName: "code_execution",
        state: "output-available",
        input: { code: "print('done')" },
        providerExecuted: true,
        output: {
          type: "encrypted_code_execution_result",
          encryptedStdout: "s".repeat(5_548),
          preview: "p".repeat(10_000)
        }
      }
    ]
  } as unknown as ChatMessage;
}

describe("Canonical persistence and display projection", () => {
  it("stores canonical and display variants separately", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);
    await agentStub.persistMessages([makeProviderExecutedMessage("pair-1")]);

    const canonical = (await agentStub.getCanonicalMessages()) as ChatMessage[];
    const display = (await agentStub.getPersistedMessages()) as ChatMessage[];

    const canonicalOutput = (
      canonical[0].parts[0] as { output: Record<string, unknown> }
    ).output;
    const displayOutput = (
      display[0].parts[0] as { output: Record<string, unknown> }
    ).output;

    expect(canonicalOutput.preview).toHaveLength(10_000);
    expect(displayOutput.preview as string).toContain(
      "… [truncated, original length: 10000]"
    );
    expect(displayOutput.encryptedStdout).toBe(canonicalOutput.encryptedStdout);

    ws.close(1000);
  });

  it("keeps live replay state canonical while get-messages returns display projection", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);
    await agentStub.persistMessages([makeProviderExecutedMessage("pair-2")]);

    const liveMessages =
      (await agentStub.getLiveMessagesForTest()) as ChatMessage[];
    const liveOutput = (
      liveMessages[0].parts[0] as { output: Record<string, unknown> }
    ).output;
    expect(liveOutput.preview).toHaveLength(10_000);

    ws.close(1000);

    const res = await exports.default.fetch(
      `http://example.com/agents/test-chat-agent/${room}/get-messages`
    );
    expect(res.status).toBe(200);

    const returned = (await res.json()) as ChatMessage[];
    const returnedOutput = (
      returned[0].parts[0] as { output: Record<string, unknown> }
    ).output;
    expect(returnedOutput.preview as string).toContain(
      "… [truncated, original length: 10000]"
    );
  });

  it("falls back to display rows when canonical rows are missing", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);
    await agentStub.persistMessages([makeProviderExecutedMessage("pair-3")]);
    await agentStub.deleteCanonicalMessage("pair-3");

    const loaded =
      (await agentStub.loadCanonicalMessagesForTest()) as ChatMessage[];
    const output = (loaded[0].parts[0] as { output: Record<string, unknown> })
      .output;

    expect(output.preview as string).toContain(
      "… [truncated, original length: 10000]"
    );

    ws.close(1000);
  });

  it("updates canonical and display stores together for tool-result mutations", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);
    await agentStub.persistMessages([
      {
        id: "tool-user",
        role: "user",
        parts: [{ type: "text", text: "Run code" }]
      },
      {
        id: "tool-assistant",
        role: "assistant",
        parts: [
          {
            type: "tool-code_execution",
            toolCallId: "tool-call-1",
            toolName: "code_execution",
            state: "input-available",
            input: { code: "print('done')" },
            providerExecuted: true
          }
        ]
      } as unknown as ChatMessage
    ]);

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_TOOL_RESULT,
        toolCallId: "tool-call-1",
        toolName: "code_execution",
        output: {
          type: "encrypted_code_execution_result",
          encryptedStdout: "s".repeat(5_548),
          preview: "p".repeat(10_000)
        }
      })
    );

    await new Promise((r) => setTimeout(r, 200));

    const canonical = (await agentStub.getCanonicalMessages()) as ChatMessage[];
    const display = (await agentStub.getPersistedMessages()) as ChatMessage[];

    const canonicalOutput = (
      canonical[1].parts[0] as { output: Record<string, unknown> }
    ).output;
    const displayOutput = (
      display[1].parts[0] as { output: Record<string, unknown> }
    ).output;

    expect(canonicalOutput.preview).toHaveLength(10_000);
    expect(displayOutput.preview as string).toContain(
      "… [truncated, original length: 10000]"
    );

    ws.close(1000);
  });

  it("clears canonical rows alongside display rows", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);
    await agentStub.persistMessages([
      {
        id: "clear-canonical-user",
        role: "user",
        parts: [{ type: "text", text: "Hello" }]
      },
      makeProviderExecutedMessage("clear-canonical-assistant")
    ]);

    expect(await agentStub.getMessageCount()).toBe(2);
    expect(await agentStub.getCanonicalMessageCount()).toBe(2);

    ws.send(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR }));
    await new Promise((r) => setTimeout(r, 100));

    expect(await agentStub.getMessageCount()).toBe(0);
    expect(await agentStub.getCanonicalMessageCount()).toBe(0);

    ws.close(1000);
  });

  it("trims canonical rows when maxPersistedMessages deletes old history", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);
    await agentStub.setMaxPersistedMessages(1);

    await agentStub.persistMessages([
      {
        id: "max-1",
        role: "user",
        parts: [{ type: "text", text: "first" }]
      },
      {
        id: "max-2",
        role: "assistant",
        parts: [{ type: "text", text: "second" }]
      }
    ]);

    const display = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const canonical = (await agentStub.getCanonicalMessages()) as ChatMessage[];

    expect(display.map((message) => message.id)).toEqual(["max-2"]);
    expect(canonical.map((message) => message.id)).toEqual(["max-2"]);

    ws.close(1000);
  });
});
