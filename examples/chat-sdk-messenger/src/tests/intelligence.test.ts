import { Message } from "chat";
import type { Thread } from "chat";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import {
  aiReplyFailureMode,
  aiReplyRecoveryMode,
  type AiReplySnapshot
} from "../intelligence/delivery";
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
} from "@cloudflare/think/messengers";
import {
  isExpectedTelegramFinalEditNoop as isExpectedFinalEditNoop,
  isTelegramIgnorableDeliveryError as isIgnorableDeliveryError,
  splitTelegramMessageText
} from "@cloudflare/think/messengers/telegram";

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
    expect(aiReplyFailureMode(true, true)).toBe("error");
    expect(aiReplyFailureMode(true, false, true)).toBeNull();
  });

  it("classifies Telegram no-op edit errors as ignorable delivery failures", () => {
    expect(
      isIgnorableDeliveryError({
        code: "VALIDATION_ERROR",
        message:
          "Bad Request: message is not modified: specified new message content is exactly the same"
      })
    ).toBe(true);
    expect(
      isIgnorableDeliveryError({
        code: "VALIDATION_ERROR",
        message: "Bad Request: message text is empty"
      })
    ).toBe(false);
    expect(isIgnorableDeliveryError(new Error("network failed"))).toBe(false);
  });

  it("only treats final edit no-op errors as expected after the visible limit", () => {
    const limitReached = { visibleLimitReached: () => true };
    const limitNotReached = { visibleLimitReached: () => false };
    const noopError = {
      code: "VALIDATION_ERROR",
      message: "Bad Request: message is not modified"
    };

    expect(isExpectedFinalEditNoop(noopError, limitReached)).toBe(true);
    expect(isExpectedFinalEditNoop(noopError, limitNotReached)).toBe(false);
    expect(
      isExpectedFinalEditNoop(
        { code: "NETWORK_ERROR", message: "fetch failed" },
        limitReached
      )
    ).toBe(false);
  });

  it("does not suppress model failures after an expected delivery no-op", () => {
    const limitReached = { visibleLimitReached: () => true };
    const deliveryNoop = {
      code: "VALIDATION_ERROR",
      message: "Bad Request: message is not modified"
    };
    const modelError = new Error("model rate limited");

    expect(isExpectedFinalEditNoop(deliveryNoop, limitReached)).toBe(true);
    expect(isExpectedFinalEditNoop(modelError, limitReached)).toBe(false);
    expect(
      aiReplyFailureMode(
        true,
        false,
        isExpectedFinalEditNoop(modelError, limitReached)
      )
    ).toBe("apologize");
  });

  it("splits long Telegram follow-up text without dropping boundary text", () => {
    const text = "  alpha beta\n\ngamma delta  \n epsilon zeta  ";
    const chunks = splitTelegramMessageText(text, 18);

    expect(chunks.every((chunk) => chunk.length <= 18)).toBe(true);
    expect(chunks.join("")).toBe(text);
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

  it("can stop the visible stream while continuing to collect full text", async () => {
    const callback = new TextStreamCallback({ visibleSoftLimit: 5 });
    const chunks = collectText(callback.stream());

    callback.onEvent(
      JSON.stringify({ type: "text-delta", id: "t1", delta: "hello" })
    );
    callback.onEvent(
      JSON.stringify({ type: "text-delta", id: "t1", delta: " world" })
    );

    await expect(chunks).resolves.toBe("hello");
    expect(callback.visibleText()).toBe("hello");
    expect(callback.textSoFar()).toBe("hello world");
    expect(callback.remainingText()).toBe(" world");
    expect(callback.visibleLimitReached()).toBe(true);

    callback.onEvent(
      JSON.stringify({ type: "text-delta", id: "t1", delta: " again" })
    );
    callback.onDone();

    expect(callback.textSoFar()).toBe("hello world again");
    expect(callback.remainingText()).toBe(" world again");
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
