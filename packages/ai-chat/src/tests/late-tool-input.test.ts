import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import type { UIMessage as ChatMessage } from "ai";
import { MessageType } from "../types";
import { connectChatWS, isUseChatResponseMessage } from "./test-utils";
import { getAgentByName } from "agents";

describe("tool-input-available after tool-approval-request (#1872)", () => {
  it("persists the canonical input without forwarding the late chunk", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const streamedTypes: string[] = [];
    const done = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5000);
      ws.addEventListener("message", (e: MessageEvent) => {
        const data = JSON.parse(e.data as string);
        if (!isUseChatResponseMessage(data)) return;
        if (typeof data.body === "string" && data.body.length > 0) {
          try {
            streamedTypes.push(JSON.parse(data.body).type);
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

    // The client keeps its approval card: the late chunk never reaches it.
    expect(streamedTypes).toContain("tool-approval-request");
    expect(streamedTypes).not.toContain("tool-input-available");

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
