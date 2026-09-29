import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import type { UIMessage as ChatMessage } from "ai";
import { MessageType } from "../types";
import { connectChatWS, isUseChatResponseMessage } from "./test-utils";
import { getAgentByName } from "agents";

const approvedAssistant: ChatMessage = {
  id: "a-approval",
  role: "assistant",
  parts: [
    {
      type: "tool-deleteFile",
      toolCallId: "call-stale-approval",
      state: "approval-responded",
      input: { path: "notes.txt" },
      approval: { id: "approval-stale", approved: true }
    } as ChatMessage["parts"][number]
  ]
};

async function sendTurn(room: string, messages: ChatMessage[]) {
  const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
  const done = new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), 5000);
    ws.addEventListener("message", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      if (isUseChatResponseMessage(data) && data.done === true) {
        clearTimeout(timeout);
        resolve(true);
      }
    });
  });
  await new Promise((r) => setTimeout(r, 50));
  ws.send(
    JSON.stringify({
      type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
      id: crypto.randomUUID(),
      init: { method: "POST", body: JSON.stringify({ messages }) }
    })
  );
  expect(await done).toBe(true);
  ws.close(1000);
}

async function persistedToolPart(room: string) {
  const agentStub = await getAgentByName(env.TestChatAgent, room);
  const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];
  return persisted
    .flatMap((message) => message.parts)
    .find(
      (part) =>
        "toolCallId" in part && part.toolCallId === "call-stale-approval"
    ) as Record<string, unknown> | undefined;
}

describe("approved tool that never ran (#2382)", () => {
  it("settles it once a new user message moves past it", async () => {
    const room = crypto.randomUUID();
    await sendTurn(room, [
      {
        id: "u-1",
        role: "user",
        parts: [{ type: "text", text: "Delete notes.txt" }]
      },
      approvedAssistant,
      { id: "u-2", role: "user", parts: [{ type: "text", text: "thanks" }] }
    ]);

    expect(await persistedToolPart(room)).toMatchObject({
      state: "output-error",
      errorText:
        "The tool call was approved but did not run before the next turn started."
    });
  });

  it("keeps it when the transcript ends with the approval", async () => {
    const room = crypto.randomUUID();
    await sendTurn(room, [
      {
        id: "u-1",
        role: "user",
        parts: [{ type: "text", text: "Delete notes.txt" }]
      },
      approvedAssistant
    ]);

    expect((await persistedToolPart(room))?.state).toBe("approval-responded");
  });
});
