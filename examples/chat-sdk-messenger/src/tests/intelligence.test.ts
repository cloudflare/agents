import { Message } from "chat";
import type { Thread } from "chat";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import {
  aiReplyFailureMode,
  aiReplyRecoveryMode,
  type AiReplySnapshot
} from "../index";
import {
  conversationNameForThread,
  extractLatestAssistantText,
  isAskCommand,
  isMenuCommand,
  isResetCommand,
  shouldRouteToAi,
  toThinkUserMessage
} from "../intelligence/messages";
import {
  TextStreamCallback,
  textDeltaFromStreamChunk
} from "../intelligence/stream-callback";

function createMessage(
  text: string,
  options: { id?: string; isMention?: boolean } = {}
): Message {
  return new Message({
    id: options.id ?? "message-1",
    threadId: "telegram:chat:thread",
    text,
    formatted: {
      type: "root",
      children: [
        { type: "paragraph", children: [{ type: "text", value: text }] }
      ]
    },
    raw: {},
    author: {
      userId: "telegram:user",
      userName: "ada",
      fullName: "Ada Lovelace",
      isBot: false,
      isMe: false
    },
    metadata: { dateSent: new Date(), edited: false },
    attachments: [],
    isMention: options.isMention
  });
}

describe("Telegram intelligence helpers", () => {
  it("detects control commands", () => {
    expect(isMenuCommand("/menu")).toBe(true);
    expect(isMenuCommand("/menu@cloudflare_chat_sdk_bot")).toBe(true);
    expect(isAskCommand("/ask explain Workers AI")).toBe(true);
    expect(isAskCommand("/ask@cloudflare_chat_sdk_bot explain")).toBe(true);
    expect(isResetCommand("/reset")).toBe(true);
    expect(isResetCommand("please reset")).toBe(false);
  });

  it("routes direct messages, mentions, and ask commands to AI", () => {
    expect(shouldRouteToAi({ isDM: true, text: "what can you do?" })).toBe(
      true
    );
    expect(shouldRouteToAi({ isDM: true, text: "/menu" })).toBe(false);
    expect(shouldRouteToAi({ isDM: true, text: "/reset" })).toBe(false);
    expect(
      shouldRouteToAi({ isDM: false, isMention: true, text: "@bot help" })
    ).toBe(true);
    expect(shouldRouteToAi({ isDM: false, text: "/ask summarize this" })).toBe(
      true
    );
    expect(
      shouldRouteToAi({ isDM: false, text: "ambient group chatter" })
    ).toBe(false);
  });

  it("uses the Chat SDK thread id as the Think conversation name", () => {
    const thread = { id: "telegram:-100123:42" } satisfies Pick<Thread, "id">;

    expect(conversationNameForThread(thread)).toBe("telegram:-100123:42");
  });

  it("converts Chat SDK messages into stable Think user messages", () => {
    const message = createMessage("/ask what is Durable Object storage?", {
      id: "telegram-message-123"
    });

    expect(toThinkUserMessage(message)).toEqual({
      id: "telegram:telegram-message-123",
      role: "user",
      parts: [
        {
          type: "text",
          text: "Ada Lovelace: what is Durable Object storage?"
        }
      ]
    });
  });

  it("extracts the latest non-empty assistant text response", () => {
    const messages: UIMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "hello" }]
      },
      {
        id: "assistant-empty",
        role: "assistant",
        parts: []
      },
      {
        id: "assistant-final",
        role: "assistant",
        parts: [{ type: "text", text: "Hi there." }]
      }
    ];

    expect(extractLatestAssistantText(messages)).toBe("Hi there.");
  });

  it("maps durable AI reply recovery snapshots to visible recovery actions", () => {
    const base = {
      type: "chat-sdk-messenger:ai-reply",
      thread: {},
      message: {}
    } satisfies Omit<AiReplySnapshot, "stage">;

    expect(aiReplyRecoveryMode({ ...base, stage: "accepted" })).toBe("answer");
    expect(aiReplyRecoveryMode({ ...base, stage: "streaming" })).toBe(
      "apologize"
    );
    expect(aiReplyRecoveryMode({ ...base, stage: "completed" })).toBeNull();
  });

  it("maps partial stream failures to apology mode", () => {
    expect(aiReplyFailureMode(true)).toBe("apologize");
    expect(aiReplyFailureMode(false)).toBe("error");
  });

  it("extracts text deltas from Think chat stream chunks", () => {
    expect(
      textDeltaFromStreamChunk(
        JSON.stringify({ type: "text-delta", id: "t1", delta: "hello" })
      )
    ).toBe("hello");
    expect(
      textDeltaFromStreamChunk(JSON.stringify({ type: "text-start", id: "t1" }))
    ).toBeNull();
    expect(textDeltaFromStreamChunk("not json")).toBeNull();
  });

  it("tracks streamed text and closes cleanly", async () => {
    const callback = new TextStreamCallback();
    const chunks = collectText(callback.stream());

    callback.onStart({ requestId: "request-1" });
    callback.onEvent(
      JSON.stringify({ type: "text-delta", id: "t1", delta: "hello" })
    );
    callback.onEvent(JSON.stringify({ type: "text-start", id: "t1" }));
    callback.onEvent(
      JSON.stringify({ type: "text-delta", id: "t1", delta: " world" })
    );
    callback.onDone();

    await expect(chunks).resolves.toBe("hello world");
    expect(callback.hasText()).toBe(true);
    expect(callback.textSoFar()).toBe("hello world");
    expect(callback.requestId()).toBe("request-1");
  });

  it("surfaces callback stream errors to consumers", async () => {
    const callback = new TextStreamCallback();
    const chunks = collectText(callback.stream());

    callback.onError("model failed");

    await expect(chunks).rejects.toThrow("model failed");
    expect(callback.hasText()).toBe(false);
  });
});

async function collectText(stream: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const chunk of stream) {
    text += chunk;
  }
  return text;
}
