import { Chat, Message } from "chat";
import type { Adapter, StateAdapter, Thread } from "chat";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import {
  aiReplyFailureMode,
  aiReplyRecoveryMode,
  aiReplySnapshot,
  EMPTY_AI_RESPONSE,
  parseAiReplySnapshot,
  reviveReplyThread,
  type AiReplySnapshot
} from "../intelligence/delivery";
import {
  conversationNameForThread,
  extractLatestAssistantText,
  isAskCommand,
  isMenuCommand,
  isResetCommand,
  planBurst,
  shouldRouteToAi,
  toThinkUserMessage
} from "../intelligence/messages";
import { TextStreamCallback } from "@cloudflare/think/messengers";
import {
  isExpectedTelegramFinalEditNoop as isExpectedFinalEditNoop,
  isTelegramIgnorableDeliveryError as isIgnorableDeliveryError,
  splitTelegramMessageText
} from "@cloudflare/think/messengers/telegram";

const BOB = {
  userId: "telegram:bob",
  userName: "bob",
  fullName: "Bob Babbage",
  isBot: false,
  isMe: false
} as const;

function createMessage(
  text: string,
  options: {
    author?: Message["author"];
    id?: string;
    isMention?: boolean;
  } = {}
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
    author: options.author ?? {
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

describe("recovered reply threads", () => {
  function recordingBot() {
    const sent: Array<{ kind: "post" | "edit"; text: string }> = [];
    const text = (message: unknown) =>
      typeof message === "string"
        ? message
        : String((message as { markdown?: string }).markdown);
    const adapter = {
      name: "fake",
      userName: "bot",
      editMessage: (threadId: string, id: string, message: unknown) => {
        sent.push({ kind: "edit", text: text(message) });
        return Promise.resolve({ id, raw: {}, threadId });
      },
      postMessage: (threadId: string, message: unknown) => {
        sent.push({ kind: "post", text: text(message) });
        return Promise.resolve({ id: "reply", raw: {}, threadId });
      },
      startTyping: () => Promise.resolve()
    } as unknown as Adapter;
    const bot = new Chat({
      adapters: { fake: adapter },
      fallbackStreamingPlaceholderText: null,
      state: {} as StateAdapter,
      userName: "bot"
    });
    return { bot, sent };
  }

  async function* reply() {
    yield "Hello";
    yield " there";
  }

  it("posts the reply text first instead of a `...` placeholder", async () => {
    const { bot, sent } = recordingBot();
    const thread = reviveReplyThread(bot, {
      _type: "chat:Thread",
      adapterName: "fake",
      channelId: "fake:dm",
      id: "fake:dm",
      isDM: true
    });

    await thread.post(reply());

    expect(sent[0]).toMatchObject({ kind: "post" });
    expect(sent[0].text).toContain("Hello");
    expect(sent.map((entry) => entry.text)).not.toContain("...");
  });
});

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

  it("folds a burst from one sender into a single labelled turn", () => {
    const skipped = [
      createMessage("summarize the thread", { id: "m1" }),
      createMessage("for me", { id: "m2" })
    ];
    const message = createMessage("and keep it short", { id: "m3" });

    expect(toThinkUserMessage(message, skipped)).toEqual({
      id: "telegram:m3",
      role: "user",
      parts: [
        {
          type: "text",
          text: "Ada Lovelace: summarize the thread\nfor me\nand keep it short"
        }
      ]
    });
  });

  it("keeps each sender's label when a burst mixes senders", () => {
    const skipped = [
      createMessage("/ask is the deploy done?", { author: BOB, id: "m1" }),
      createMessage("", { author: BOB, id: "m2" })
    ];
    const message = createMessage("what changed?", { id: "m3" });

    expect(toThinkUserMessage(message, skipped).parts).toEqual([
      {
        type: "text",
        text: "Bob Babbage: is the deploy done?\nAda Lovelace: what changed?"
      }
    ]);
  });

  it("labels different senders who share a display name separately", () => {
    const otherAda = { ...BOB, fullName: "Ada Lovelace", userId: "other" };
    const skipped = [createMessage("deploy failed", { id: "m1" })];
    const message = createMessage("I will investigate", {
      author: otherAda,
      id: "m2"
    });

    expect(toThinkUserMessage(message, skipped).parts).toEqual([
      {
        type: "text",
        text: "Ada Lovelace: deploy failed\nAda Lovelace: I will investigate"
      }
    ]);
  });

  it("runs burst commands before the lines sent after them", () => {
    const ids = (plan: ReturnType<typeof planBurst>) =>
      plan.messages.map((entry) => entry.id);

    const afterReset = planBurst(
      createMessage("what did we discuss?", { id: "m3" }),
      [
        createMessage("old question", { id: "m1" }),
        createMessage("/reset", { id: "m2" })
      ]
    );
    expect(afterReset.reset).toBe(true);
    expect(ids(afterReset)).toEqual(["m3"]);

    const withMenu = planBurst(createMessage("hello", { id: "m2" }), [
      createMessage("/menu", { id: "m1" })
    ]);
    expect(withMenu).toMatchObject({ menu: true, reset: false });
    expect(ids(withMenu)).toEqual(["m2"]);

    const onlyReset = planBurst(createMessage("/reset", { id: "m2" }), [
      createMessage("old question", { id: "m1" })
    ]);
    expect(onlyReset).toMatchObject({ menu: false, reset: true });
    expect(onlyReset.messages).toEqual([]);

    const plain = planBurst(createMessage("hi", { id: "m1" }));
    expect(plain).toMatchObject({ menu: false, reset: false });
    expect(ids(plain)).toEqual(["m1"]);
  });

  it("keeps burst messages in the recovery snapshot", () => {
    const thread = { toJSON: () => ({ id: "telegram:chat:thread" }) };
    const message = createMessage("and keep it short", { id: "m2" });
    const skipped = [createMessage("summarize the thread", { id: "m1" })];

    const snapshot = parseAiReplySnapshot(
      JSON.parse(
        JSON.stringify(
          aiReplySnapshot(
            "accepted",
            thread as unknown as Thread,
            message,
            skipped
          )
        )
      )
    );
    expect(snapshot?.skipped).toEqual([
      expect.objectContaining({ id: "m1", text: "summarize the thread" })
    ]);

    const solo = aiReplySnapshot(
      "accepted",
      thread as unknown as Thread,
      message
    );
    expect(solo).not.toHaveProperty("skipped");
    expect(parseAiReplySnapshot(solo)).not.toHaveProperty("skipped");
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

  it("streams the empty-response text when a turn completes without text", async () => {
    const callback = new TextStreamCallback({ emptyText: EMPTY_AI_RESPONSE });
    const chunks = collectText(callback.stream());

    callback.onDone();

    await expect(chunks).resolves.toBe(EMPTY_AI_RESPONSE);
    expect(callback.hasText()).toBe(false);
    expect(callback.remainingText()).toBe("");
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
