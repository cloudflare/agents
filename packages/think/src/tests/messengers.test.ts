import { env } from "cloudflare:workers";
import type {
  FiberContext,
  FiberRecoveryContext,
  FiberRecoveryResult
} from "agents";
import { getAgentByName } from "agents";
import type { Adapter } from "chat";
import { describe, expect, it } from "vitest";
import {
  chatSdkMessenger,
  defaultChatSdkEvent,
  defaultConversationName,
  deliverMessengerReply,
  EMPTY_MESSENGER_RESPONSE,
  ERROR_MESSENGER_RESPONSE,
  INTERRUPTED_MESSENGER_RESPONSE,
  idempotencyKeyForEvent,
  MESSENGER_REPLY_FIBER_NAME,
  messengerReplyFailureMode,
  messengerReplyRecoveryMode,
  messengerReplySnapshot,
  normalizeMessengers,
  parseMessengerReplySnapshot,
  serializableMessengerEvent,
  TextStreamCallback,
  textDeltaFromStreamChunk,
  ThinkMessengerRuntime,
  toMessengerUserMessage,
  type MessengerEvent,
  type MessengerThinkHost
} from "../messengers";
import telegramMessenger, {
  isExpectedTelegramFinalEditNoop,
  isTelegramIgnorableDeliveryError,
  shardTelegramStateKey,
  splitTelegramMessageText,
  telegramSecretTokenVerifier
} from "../messengers/telegram";

const baseEvent: MessengerEvent = {
  capabilities: { canStream: true },
  kind: "mention",
  message: {
    attachments: [
      {
        mediaType: "text/plain",
        name: "notes.txt",
        size: 12,
        url: "https://example.com/notes.txt"
      }
    ],
    author: {
      fullName: "Ada Lovelace",
      userId: "telegram:user",
      userName: "ada"
    },
    id: "message-1",
    isMention: true,
    providerMessageId: "message-1",
    text: "summarize this"
  },
  messengerId: "telegram",
  provider: "telegram",
  thread: {
    id: "telegram:-100123:42",
    isDirectMessage: false,
    providerThreadId: "telegram:-100123:42",
    title: "General"
  }
};

describe("think messengers core", () => {
  it("normalizes inferred defaults", () => {
    const adapter = {} as never;
    const [definition] = normalizeMessengers({
      fake: chatSdkMessenger({
        adapter,
        provider: "fake",
        userName: "fake_bot",
        verifyWebhook: false
      })
    });

    expect(definition?.path).toBe("/messengers/fake/webhook");
    expect(definition?.respondTo).toEqual(["direct-message", "mention"]);
    expect(definition?.subscribeOnMention).toBe(true);
  });

  it("rejects invalid and duplicate paths", () => {
    const adapter = {} as never;
    expect(() =>
      normalizeMessengers({
        bad: chatSdkMessenger({
          adapter,
          path: "relative",
          provider: "fake",
          userName: "fake_bot",
          verifyWebhook: false
        })
      })
    ).toThrow('path must start with "/"');

    expect(() =>
      normalizeMessengers({
        one: chatSdkMessenger({
          adapter,
          adapterName: "one",
          path: "/same",
          provider: "fake",
          userName: "fake_bot",
          verifyWebhook: false
        }),
        two: chatSdkMessenger({
          adapter,
          adapterName: "two",
          path: "/same",
          provider: "fake",
          userName: "fake_bot",
          verifyWebhook: false
        })
      })
    ).toThrow("Duplicate messenger path");
  });

  it("rejects duplicate adapter names before creating a shared Chat runtime", () => {
    const adapter = {} as never;
    expect(() =>
      normalizeMessengers({
        one: chatSdkMessenger({
          adapter,
          adapterName: "shared",
          provider: "fake",
          userName: "fake_bot",
          verifyWebhook: false
        }),
        two: chatSdkMessenger({
          adapter,
          adapterName: "shared",
          provider: "other",
          userName: "other_bot",
          verifyWebhook: false
        })
      })
    ).toThrow("Duplicate messenger adapter name");
  });

  it("requires an explicit webhook verification posture", () => {
    const adapter = {} as never;
    expect(() =>
      normalizeMessengers({
        insecure: chatSdkMessenger({
          adapter,
          provider: "fake",
          userName: "fake_bot"
        })
      })
    ).toThrow("requires verifyWebhook");
  });

  it("honors custom webhook verifier responses before Chat SDK handling", async () => {
    const runtime = new ThinkMessengerRuntime(
      {
        fake: chatSdkMessenger({
          adapter: fakeAdapter(),
          provider: "fake",
          userName: "fake_bot",
          verifyWebhook() {
            return new Response("blocked", { status: 403 });
          }
        })
      },
      fakeHost([])
    );
    runtime.initialize();

    const response = await runtime.handleRequest(
      new Request("https://example.com/messengers/fake/webhook", {
        method: "POST"
      })
    );

    expect(response?.status).toBe(403);
    await expect(response?.text()).resolves.toBe("blocked");
  });

  it("rejects webhook requests when custom verification returns false", async () => {
    const runtime = new ThinkMessengerRuntime(
      {
        fake: chatSdkMessenger({
          adapter: fakeAdapter(),
          provider: "fake",
          userName: "fake_bot",
          verifyWebhook() {
            return false;
          }
        })
      },
      fakeHost([])
    );
    runtime.initialize();

    const response = await runtime.handleRequest(
      new Request("https://example.com/messengers/fake/webhook", {
        method: "POST"
      })
    );

    expect(response?.status).toBe(401);
  });

  it("lets custom webhook verification read the body without consuming adapter input", async () => {
    const runtime = new ThinkMessengerRuntime(
      {
        fake: chatSdkMessenger({
          adapter: fakeAdapter({
            async handleWebhook(request?: Request) {
              return new Response(await request?.text());
            }
          }),
          provider: "fake",
          userName: "fake_bot",
          async verifyWebhook(request) {
            return (await request.text()) === "payload";
          }
        })
      },
      fakeHost([])
    );
    runtime.initialize();

    const response = await runtime.handleRequest(
      new Request("https://example.com/messengers/fake/webhook", {
        body: "payload",
        method: "POST"
      })
    );

    await expect(response?.text()).resolves.toBe("payload");
  });

  it("derives stable conversation and idempotency keys", () => {
    expect(defaultConversationName(baseEvent)).toBe(
      "messenger:telegram:telegram:-100123:42"
    );
    expect(idempotencyKeyForEvent(baseEvent)).toBe(
      "messenger:telegram:message:telegram:-100123:42:message-1"
    );

    const actionEvent: MessengerEvent = {
      ...baseEvent,
      kind: "action",
      message: undefined,
      action: {
        actionId: "approve",
        messageId: "source-message",
        user: { userId: "user-1" },
        value: "ship-it"
      }
    };
    expect(idempotencyKeyForEvent(actionEvent)).toBe(
      "messenger:telegram:message:telegram:-100123:42:action:source-message:approve:user-1:ship-it"
    );
    expect(
      idempotencyKeyForEvent({
        ...actionEvent,
        action: {
          ...actionEvent.action!,
          user: { userId: "user-2" }
        }
      })
    ).not.toBe(idempotencyKeyForEvent(actionEvent));
  });

  it("converts messenger events to Think user messages with attachments", () => {
    const message = toMessengerUserMessage(baseEvent);
    expect(message.id).toBe("telegram:message-1");
    expect(message.role).toBe("user");
    expect(message.parts).toEqual([
      {
        type: "text",
        text: [
          "Ada Lovelace: summarize this",
          "",
          "Attachments:",
          "- notes.txt (text/plain, 12 bytes, https://example.com/notes.txt)"
        ].join("\n")
      }
    ]);
  });

  it("converts messenger actions to Think user messages", () => {
    const event = defaultChatSdkEvent(
      normalizeMessengers({
        fake: chatSdkMessenger({
          adapter: fakeAdapter(),
          capabilities: { supportsActions: true },
          provider: "fake",
          userName: "fake_bot",
          verifyWebhook: false
        })
      })[0]!,
      {
        action: {
          actionId: "approve",
          adapter: fakeAdapter(),
          messageId: "source-message",
          raw: { callback: true },
          thread: null,
          threadId: "fake:thread",
          user: {
            fullName: "Ada Lovelace",
            isBot: false,
            isMe: false,
            userId: "fake:user",
            userName: "ada"
          },
          value: "ship-it"
        } as never,
        eventKind: "action",
        thread: fakeThread("fake:thread")
      }
    );

    expect(event.action).toMatchObject({
      actionId: "approve",
      messageId: "source-message",
      value: "ship-it"
    });
    expect(toMessengerUserMessage(event).parts).toEqual([
      {
        type: "text",
        text: [
          "Ada Lovelace: Action selected: approve",
          "Value: ship-it",
          "Source message: source-message"
        ].join("\n")
      }
    ]);
  });

  it("creates serializable recovery snapshots without live raw data", () => {
    const event = serializableMessengerEvent({
      ...baseEvent,
      raw: { providerPayload: true },
      message: {
        ...baseEvent.message!,
        attachments: [
          {
            data: new ArrayBuffer(1),
            fetch: () => Promise.resolve(new ArrayBuffer(1)),
            mediaType: "text/plain",
            name: "notes.txt",
            raw: { providerFile: true },
            url: "https://example.com/notes.txt"
          }
        ],
        raw: { providerMessage: true }
      }
    });
    const snapshot = messengerReplySnapshot("accepted", event, {
      _type: "chat:Thread",
      adapterName: "fake",
      channelId: "fake:thread",
      id: "fake:thread",
      isDM: false
    });
    const cloned = JSON.parse(JSON.stringify(snapshot));

    expect(cloned.event.raw).toBeUndefined();
    expect(cloned.event.message.raw).toBeUndefined();
    expect(cloned.event.message.attachments[0].raw).toBeUndefined();
    expect(cloned.event.message.attachments[0].data).toBeUndefined();
    expect(cloned.event.message.attachments[0].fetch).toBeUndefined();
    expect(cloned.thread._type).toBe("chat:Thread");
  });

  it("parses and classifies messenger recovery snapshots", () => {
    const accepted = messengerReplySnapshot("accepted", baseEvent, {
      _type: "chat:Thread",
      adapterName: "telegram",
      channelId: "telegram:-100123",
      id: "telegram:-100123:42",
      isDM: false
    });

    expect(parseMessengerReplySnapshot(accepted)).toEqual(accepted);
    expect(messengerReplyRecoveryMode(accepted)).toBe("answer");
    expect(
      messengerReplyRecoveryMode(messengerReplySnapshot("streaming", baseEvent))
    ).toBe("apologize");
    expect(
      messengerReplyRecoveryMode(messengerReplySnapshot("completed", baseEvent))
    ).toBeNull();
    expect(parseMessengerReplySnapshot({ type: "wrong" })).toBeNull();
  });

  it("carries an additive delivery tag without changing recovery classification", () => {
    const completed = messengerReplySnapshot("completed", baseEvent);
    expect(completed.tag).toEqual({
      stage: "completed",
      kind: "final",
      turnEnded: true
    });
    expect(messengerReplyRecoveryMode(completed)).toBeNull();

    const streaming = messengerReplySnapshot("streaming", baseEvent);
    expect(streaming.tag).toEqual({
      stage: "streaming",
      kind: "interim",
      turnEnded: false
    });
    expect(messengerReplyRecoveryMode(streaming)).toBe("apologize");

    const tagged = messengerReplySnapshot("accepted", baseEvent, undefined, {
      stage: "accepted",
      kind: "command",
      turnEnded: false
    });
    const parsed = parseMessengerReplySnapshot(tagged);
    expect(parsed?.tag).toEqual({
      stage: "accepted",
      kind: "command",
      turnEnded: false
    });
    expect(messengerReplyRecoveryMode(tagged)).toBe("answer");
  });

  it("recovers interrupted messenger reply fibers through the shared Chat runtime", async () => {
    const posted: string[] = [];
    const resolved: FiberRecoveryResult[] = [];
    const runtime = new ThinkMessengerRuntime(
      {
        fake: chatSdkMessenger({
          adapter: fakeAdapter({
            postMessage(_threadId, message) {
              posted.push(String(message));
              return Promise.resolve({
                id: "posted",
                raw: {},
                threadId: "fake:thread"
              });
            }
          }),
          delivery: { interruptedResponseText: "interrupted" },
          provider: "fake",
          userName: "fake_bot",
          verifyWebhook: false
        })
      },
      fakeHost(resolved)
    );
    runtime.initialize();

    const fakeEvent: MessengerEvent = {
      ...baseEvent,
      messengerId: "fake",
      provider: "fake",
      thread: {
        ...baseEvent.thread,
        id: "fake:thread",
        providerThreadId: "fake:thread"
      }
    };
    const handled = await runtime.handleFiberRecovery({
      createdAt: Date.now(),
      id: "fiber-1",
      name: MESSENGER_REPLY_FIBER_NAME,
      recoveryReason: "interrupted",
      snapshot: messengerReplySnapshot("streaming", fakeEvent, {
        _type: "chat:Thread",
        adapterName: "fake",
        channelId: "fake:thread",
        id: "fake:thread",
        isDM: false
      })
    } satisfies FiberRecoveryContext);

    expect(handled).toBe(true);
    expect(posted).toEqual(["interrupted"]);
    expect(resolved).toEqual([{ status: "completed" }]);
  });

  it("extracts streamed text deltas", () => {
    expect(
      textDeltaFromStreamChunk(
        JSON.stringify({ type: "text-delta", delta: "hello" })
      )
    ).toBe("hello");
    expect(textDeltaFromStreamChunk("{")).toBeNull();
  });

  it("streams visible text while retaining overflow", async () => {
    const callback = new TextStreamCallback({ visibleSoftLimit: 5 });
    const chunks = collectText(callback.stream());
    callback.onEvent(JSON.stringify({ type: "text-delta", delta: "hello" }));
    callback.onEvent(JSON.stringify({ type: "text-delta", delta: " world" }));
    callback.close();

    await expect(chunks).resolves.toEqual(["hello"]);
    expect(callback.remainingText()).toBe(" world");
    expect(callback.visibleLimitReached()).toBe(true);
  });

  it("marks messenger reply fibers as streaming only when visible text starts", async () => {
    const stages: string[] = [];
    const posts: string[] = [];

    await deliverMessengerReply({
      event: baseEvent,
      fiber: {
        stash(snapshot: unknown) {
          stages.push(
            parseMessengerReplySnapshot(snapshot)?.stage ?? "unknown"
          );
        }
      } as unknown as FiberContext,
      surface: {
        async post(message) {
          if (isAsyncIterable(message)) {
            posts.push(...(await collectText(message)));
          }
        }
      },
      target: {
        cancelChat() {
          return Promise.resolve(false);
        },
        chat(_message, callback) {
          expect(stages).toEqual([]);
          callback.onEvent(
            JSON.stringify({ type: "text-delta", delta: "hello" })
          );
          return Promise.resolve();
        }
      }
    });

    expect(posts).toEqual(["hello"]);
    expect(stages).toEqual(["streaming", "completed"]);
  });

  it("surfaces the interrupted apology, not a truncated final reply, when the model turn is interrupted by recovery (#1644)", async () => {
    const posts: string[] = [];
    const stages: string[] = [];

    await deliverMessengerReply({
      event: baseEvent,
      fiber: {
        stash(snapshot: unknown) {
          stages.push(
            parseMessengerReplySnapshot(snapshot)?.stage ?? "unknown"
          );
        }
      } as unknown as FiberContext,
      surface: {
        async post(message) {
          if (isAsyncIterable(message)) {
            posts.push(...(await collectText(message)));
            return;
          }
          posts.push(typeof message === "string" ? message : message.markdown);
        }
      },
      target: {
        cancelChat() {
          return Promise.resolve(false);
        },
        chat(_message, callback) {
          callback.onStart({ requestId: "req-interrupted" });
          callback.onEvent(
            JSON.stringify({ type: "text-delta", delta: "partial answer" })
          );
          // The attempt is interrupted and routed into bounded recovery; the
          // real answer is produced later by the continuation (WS only). A
          // clean resolve must NOT be treated as completion.
          callback.onInterrupted?.();
          return Promise.resolve();
        }
      }
    });

    // The user is told the reply was interrupted (so they can retry) rather
    // than receiving the truncated partial as the final answer...
    expect(posts).toContain(INTERRUPTED_MESSENGER_RESPONSE);
    // ...and the "empty response" fallback must NOT fire (the turn wasn't a
    // completed-with-no-text turn — it was interrupted).
    expect(posts).not.toContain(EMPTY_MESSENGER_RESPONSE);
    // The one-shot delivery is checkpointed completed (recovery owns the WS
    // answer; this surface won't receive it).
    expect(stages).toContain("completed");
  });

  it("delivers successful replies with active messenger context and overflow chunks", async () => {
    const posts: string[] = [];
    let seenContext: MessengerEvent | undefined;

    await deliverMessengerReply({
      event: baseEvent,
      policy: {
        splitText(text) {
          return text ? [text] : [];
        },
        visibleSoftLimit: 2
      },
      surface: {
        async post(message) {
          if (isAsyncIterable(message)) {
            posts.push(...(await collectText(message)));
            return;
          }
          posts.push(typeof message === "string" ? message : message.markdown);
        }
      },
      target: {
        cancelChat() {
          return Promise.resolve(false);
        },
        chat() {
          throw new Error("chatWithMessengerContext should be preferred");
        },
        chatWithMessengerContext(_message, callback, context) {
          seenContext = context;
          callback.onEvent(
            JSON.stringify({ type: "text-delta", delta: "hello" })
          );
          return Promise.resolve();
        }
      }
    });

    expect(seenContext?.thread.id).toBe(baseEvent.thread.id);
    expect(posts).toEqual(["he", "llo"]);
  });

  it("does not leak internal error details into messenger replies", async () => {
    const posts: unknown[] = [];
    await deliverMessengerReply({
      event: baseEvent,
      surface: {
        post(message) {
          posts.push(message);
          return Promise.resolve();
        }
      },
      target: {
        cancelChat() {
          return Promise.resolve(false);
        },
        chat() {
          throw new Error("secret database hostname");
        }
      }
    });

    expect(posts.at(-1)).toEqual({ markdown: ERROR_MESSENGER_RESPONSE });
    expect(JSON.stringify(posts)).not.toContain("secret database hostname");
  });

  it("preserves delivery errors when cancelling local self targets", async () => {
    const policyErrors: string[] = [];
    const posts: unknown[] = [];

    await deliverMessengerReply({
      event: baseEvent,
      policy: {
        isExpectedDeliveryCompletion(error) {
          policyErrors.push(
            error instanceof Error ? error.message : String(error)
          );
          return false;
        }
      },
      surface: {
        async post(message) {
          if (isAsyncIterable(message)) {
            for await (const chunk of message) {
              posts.push(chunk);
            }
            throw new Error("delivery failed");
          }
          posts.push(message);
        }
      },
      target: {
        cancelChat() {
          return undefined;
        },
        chat(_message, callback) {
          callback.onStart({ requestId: "request-1" });
          callback.onEvent(
            JSON.stringify({ type: "text-delta", delta: "hello" })
          );
          return Promise.resolve();
        }
      }
    });

    expect(policyErrors).toEqual(["delivery failed", "delivery failed"]);
    expect(posts).toEqual(["hello", { markdown: ERROR_MESSENGER_RESPONSE }]);
  });

  it("classifies messenger delivery failures", () => {
    expect(messengerReplyFailureMode(false)).toBe("error");
    expect(messengerReplyFailureMode(true)).toBe("apologize");
    expect(messengerReplyFailureMode(true, true)).toBe("error");
    expect(messengerReplyFailureMode(true, true, true)).toBeNull();
  });

  it("handles Think internal, messenger, and fallback request precedence", async () => {
    const agent = await getAgentByName(
      env.ThinkMessengerRouteTestAgent,
      "route-precedence"
    );

    const messages = await agent.fetch("https://example.com/get-messages");
    expect(messages.headers.get("content-type")).toContain("application/json");

    const messenger = await agent.fetch(
      "https://example.com/messengers/fake/webhook",
      { method: "POST" }
    );
    await expect(messenger.text()).resolves.toBe("messenger");

    const fallback = await agent.fetch("https://example.com/custom");
    await expect(fallback.text()).resolves.toBe("fallback");
  });
});

describe("telegram messenger provider", () => {
  it("requires explicit webhook verification posture", () => {
    expect(() =>
      telegramMessenger({
        token: "token",
        userName: "fake_bot"
      })
    ).toThrow("requires secretToken");

    expect(() =>
      telegramMessenger({
        token: "token",
        userName: "fake_bot",
        verifyWebhook: false
      })
    ).not.toThrow();

    expect(() =>
      telegramMessenger({
        token: "token",
        userName: "fake_bot",
        verifyWebhook() {
          return true;
        }
      })
    ).not.toThrow();
  });

  it("supports distinct Telegram adapter names and rejects duplicate defaults", () => {
    expect(() =>
      normalizeMessengers({
        first: telegramMessenger({
          secretToken: "secret",
          token: "token-1",
          userName: "first_bot"
        }),
        second: telegramMessenger({
          secretToken: "secret",
          token: "token-2",
          userName: "second_bot"
        })
      })
    ).toThrow("Duplicate messenger adapter name: telegram");

    const definitions = normalizeMessengers({
      first: telegramMessenger({
        adapterName: "telegram-first",
        secretToken: "secret",
        token: "token-1",
        userName: "first_bot"
      }),
      second: telegramMessenger({
        adapterName: "telegram-second",
        secretToken: "secret",
        token: "token-2",
        userName: "second_bot"
      })
    });

    expect(definitions.map((definition) => definition.adapterName)).toEqual([
      "telegram-first",
      "telegram-second"
    ]);
    expect(definitions[0]?.shardKey?.("telegram:123:456")).toBe(
      "telegram-first:telegram:123"
    );
    expect(
      shardTelegramStateKey("dedupe:telegram:123:456", definitions[0]?.shardKey)
    ).toBe("telegram-first:telegram:123");
  });

  it("verifies Telegram secret token headers", () => {
    const verify = telegramSecretTokenVerifier("secret");
    expect(
      verify?.(
        new Request("https://example.com", {
          headers: { "x-telegram-bot-api-secret-token": "secret" }
        })
      )
    ).toBe(true);
    expect(verify?.(new Request("https://example.com"))).toBe(false);
  });

  it("classifies Telegram no-op edit errors", () => {
    const error = {
      code: "VALIDATION_ERROR",
      message: "Bad Request: message is not modified"
    };
    expect(isTelegramIgnorableDeliveryError(error)).toBe(true);
    expect(
      isExpectedTelegramFinalEditNoop(error, {
        visibleLimitReached: () => true
      })
    ).toBe(true);
    expect(
      isExpectedTelegramFinalEditNoop(error, {
        visibleLimitReached: () => false
      })
    ).toBe(false);
  });

  it("splits long Telegram follow-up text without dropping content", () => {
    const text = "alpha beta\n\ngamma delta epsilon";
    const chunks = splitTelegramMessageText(text, 12);
    expect(chunks.every((chunk) => chunk.length <= 12)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });
});

async function collectText(stream: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<string> {
  return (
    typeof value === "object" && value !== null && Symbol.asyncIterator in value
  );
}

function fakeHost(resolved: FiberRecoveryResult[]): MessengerThinkHost {
  return {
    cancelChat() {
      return Promise.resolve(true);
    },
    chat() {
      return Promise.resolve();
    },
    constructor: { name: "FakeHost" },
    name: "fake-host",
    parentPath: [],
    resolveFiber(_id, result) {
      resolved.push(result);
      return Promise.resolve(true);
    },
    startFiber() {
      throw new Error("startFiber is not used by this test");
    },
    subAgent() {
      throw new Error("subAgent is not used by this test");
    }
  };
}

function fakeAdapter(overrides: Partial<Adapter> = {}): Adapter {
  return {
    addReaction() {
      return Promise.resolve();
    },
    channelIdFromThreadId(threadId) {
      return threadId;
    },
    decodeThreadId(threadId) {
      return threadId;
    },
    deleteMessage() {
      return Promise.resolve();
    },
    editMessage(_threadId, _messageId, _message) {
      return Promise.resolve({ id: "edited", raw: {}, threadId: "fake" });
    },
    encodeThreadId(threadId) {
      return String(threadId);
    },
    fetchMessages() {
      return Promise.resolve({ messages: [] });
    },
    fetchThread(threadId) {
      return Promise.resolve({
        channelId: threadId,
        id: threadId,
        isDM: false,
        metadata: {}
      });
    },
    handleWebhook() {
      return Promise.resolve(new Response("messenger"));
    },
    initialize() {
      return Promise.resolve();
    },
    name: "fake",
    parseMessage() {
      throw new Error("parseMessage is not used by this test");
    },
    postMessage(threadId, message) {
      return Promise.resolve({ id: String(message), raw: {}, threadId });
    },
    removeReaction() {
      return Promise.resolve();
    },
    userName: "fake_bot",
    ...overrides
  } as Adapter;
}

function fakeThread(id: string) {
  return {
    channel: { name: "Fake" },
    channelId: id,
    id,
    isDM: false
  } as never;
}
