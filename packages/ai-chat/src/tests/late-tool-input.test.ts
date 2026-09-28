import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import type { UIMessage as ChatMessage } from "ai";
import { applyChunkToParts, type MessagePart } from "agents/chat";
import { MessageType } from "../types";
import { connectChatWS, isUseChatResponseMessage } from "./test-utils";
import { getAgentByName } from "agents";

describe("tool-input-available after tool-approval-request (#1872)", () => {
  it("persists and streams the canonical input without losing the approval", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const streamed: Array<Record<string, unknown>> = [];
    const done = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5000);
      ws.addEventListener("message", (e: MessageEvent) => {
        const data = JSON.parse(e.data as string);
        if (!isUseChatResponseMessage(data)) return;
        if (typeof data.body === "string" && data.body.length > 0) {
          try {
            streamed.push(JSON.parse(data.body));
          } catch {
            // ignore non-JSON frames
          }
        }
        if (data.done === true) {
          clearTimeout(timeout);
          resolve(true);
        }
      });
    });

    await new Promise((r) => setTimeout(r, 50));
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-late-input",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: "u-late-input",
                role: "user",
                parts: [{ type: "text", text: "Delete notes.txt" }]
              }
            ],
            lateToolInput: true
          })
        }
      })
    );

    expect(await done).toBe(true);
    ws.close(1000);

    // The late input is followed by the approval request again, so the
    // client's approval card ends up carrying the input.
    const toolChunks = streamed.filter(
      (chunk) => chunk.toolCallId === "call-late-input"
    );
    expect(toolChunks.map((chunk) => chunk.type)).toEqual([
      "tool-input-start",
      "tool-approval-request",
      "tool-input-available",
      "tool-approval-request"
    ]);
    const clientParts: MessagePart[] = [];
    for (const chunk of toolChunks) applyChunkToParts(clientParts, chunk);
    expect(clientParts[0]).toMatchObject({
      state: "approval-requested",
      input: { path: "notes.txt" }
    });

    const agentStub = await getAgentByName(env.TestChatAgent, room);
    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistant = persisted.find((m) => m.role === "assistant");
    const toolPart = assistant?.parts.find(
      (part) => "toolCallId" in part && part.toolCallId === "call-late-input"
    ) as Record<string, unknown> | undefined;
    expect(toolPart?.state).toBe("approval-requested");
    expect(toolPart?.input).toEqual({ path: "notes.txt" });
  });
});
