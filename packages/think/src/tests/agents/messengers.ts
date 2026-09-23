import type { LanguageModel, UIMessage } from "ai";
import type { Adapter, ChatInstance } from "chat";
import { Message, parseMarkdown } from "chat";
import { Think } from "../../think";
import { chatSdkMessenger, type ThinkMessengers } from "../../messengers";

const fakeAdapter = {
  channelIdFromThreadId(threadId: string) {
    return threadId;
  },
  decodeThreadId(threadId: string) {
    return threadId;
  },
  deleteMessage() {
    return Promise.resolve();
  },
  editMessage() {
    return Promise.resolve({ id: "edited", raw: {}, threadId: "fake" });
  },
  encodeThreadId(threadId: string) {
    return threadId;
  },
  fetchMessages() {
    return Promise.resolve({ messages: [] });
  },
  fetchThread(threadId: string) {
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
  postMessage() {
    return Promise.resolve({ id: "posted", raw: {}, threadId: "fake" });
  },
  removeReaction() {
    return Promise.resolve();
  },
  addReaction() {
    return Promise.resolve();
  },
  userName: "fake_bot"
} as unknown as Adapter;

/** Webhook body for {@link ThinkMessengerDeliveryTestAgent}. */
export interface FakeMessengerWebhook {
  author?: { fullName: string; userId: string };
  id: string;
  isMention?: boolean;
  text: string;
  threadId: string;
}

/**
 * Several messages delivered as one burst: the first takes the thread lock,
 * the rest are processed in-process while it waits out the burst window, so
 * outer request latency cannot push them past the window.
 */
export interface FakeMessengerBurstWebhook {
  burst: FakeMessengerWebhook[];
}

function lastUserText(prompt: unknown): string {
  const messages = Array.isArray(prompt) ? [...prompt].reverse() : [];
  const user = messages.find(
    (message: { role?: string }) => message.role === "user"
  ) as { content?: Array<{ type: string; text?: string }> } | undefined;
  return (user?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

/**
 * Drives real messenger replies end to end: each webhook is handed to the
 * runtime's own `Chat` (concurrency strategy, handlers, delivery), the model
 * reply streams back through the adapter's post/edit fallback, and both what
 * the model was asked and what the adapter sent are recorded in agent SQL.
 * Thread ids starting with `fake:dm` are direct messages.
 */
type RecoveryMode = "self" | "thread" | "exhaust" | "twice" | "empty" | "later";

export class ThinkMessengerDeliveryTestAgent extends Think {
  private _chat: ChatInstance | undefined;
  private _streamCalls = 0;
  override chatRecovery = { maxAttempts: 2 };

  /**
   * #2106: an agent named `recover-<mode>-…` fails its first model stream
   * mid-reply with an error classified as transient (`recover-exhaust-…`:
   * every stream; `recover-twice-…`: the first recovery too;
   * `recover-empty-…`: fails before any text, and recovery has none;
   * `recover-later-…`: a newer assistant message lands as recovery
   * completes), and
   * `recover-thread-…` answers in a per-thread sub-agent, which inherits the
   * mode from its parent's name.
   */
  private _recoveryMode(): RecoveryMode | undefined {
    const name = this.parentPath.at(-1)?.name ?? this.name;
    const mode = /^recover-(self|thread|exhaust|twice|empty|later)-/.exec(
      name
    )?.[1];
    return mode as RecoveryMode | undefined;
  }

  protected override _emit(
    type: Parameters<Think["_emit"]>[0],
    payload?: Record<string, unknown>
  ): void {
    super._emit(type, payload);
    if (
      type === "chat:recovery:completed" &&
      typeof payload?.incidentId === "string"
    ) {
      this._stagedAtCompletion = this.ctx.storage
        .get<{ outcome?: string }>(
          `cf_think_messenger_recovery:${payload.incidentId}`
        )
        .then((delivery) => delivery?.outcome ?? null);
    }
    if (
      type === "chat:recovery:completed" &&
      this._recoveryMode() === "later"
    ) {
      const internal = this as unknown as { _cachedMessages: UIMessage[] };
      internal._cachedMessages = [
        ...internal._cachedMessages,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          parts: [{ type: "text", text: "a later reply" }]
        }
      ];
    }
  }

  override classifyChatError(): "transient" | undefined {
    return this._recoveryMode() ? "transient" : undefined;
  }

  override getModel(): LanguageModel {
    const record = (text: string) => this._record("prompt", text);
    const mode = this._recoveryMode();
    const nextCall = () => ++this._streamCalls;
    return {
      specificationVersion: "v3",
      provider: "test",
      modelId: "messenger-delivery-mock",
      supportedUrls: {},
      doGenerate() {
        throw new Error("doGenerate not implemented in mock");
      },
      doStream(options: { prompt: unknown }) {
        record(lastUserText(options.prompt));
        const call = nextCall();
        const fails =
          mode === "exhaust" ||
          (mode !== undefined && call === 1) ||
          (mode === "twice" && call === 2);
        const failDelta =
          mode === "empty" ? "" : call === 1 ? "Got " : "it was ";
        const deltas =
          mode === "empty"
            ? []
            : mode === "twice"
              ? ["successful"]
              : mode
                ? ["it"]
                : ["Got ", "it"];
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t" });
            if (fails) {
              if (failDelta) {
                controller.enqueue({
                  type: "text-delta",
                  id: "t",
                  delta: failDelta
                });
              }
              controller.enqueue({
                type: "error",
                error: new Error("upstream connection reset")
              });
              controller.close();
              return;
            }
            for (const delta of deltas) {
              controller.enqueue({ type: "text-delta", id: "t", delta });
            }
            controller.enqueue({ type: "text-end", id: "t" });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: 0,
                  cacheWrite: 0
                },
                outputTokens: { total: 1, text: 1, reasoning: 0 }
              }
            });
            controller.close();
          }
        });
        return Promise.resolve({ stream });
      }
    } as LanguageModel;
  }

  override getMessengers(): ThinkMessengers {
    return {
      fake: chatSdkMessenger({
        adapter: this._recordingAdapter(),
        conversation: this._recoveryMode() === "thread" ? "thread" : "self",
        provider: "fake",
        userName: "fake_bot",
        verifyWebhook: false
      })
    };
  }

  async getRecorded(kind: "prompt" | "post" | "edit"): Promise<string[]> {
    this._ensureTable();
    return this.sql<{ content: string }>`
      SELECT content FROM messenger_delivery_log
      WHERE kind = ${kind} ORDER BY seq ASC
    `.map((row) => row.content);
  }

  private _stagedAtCompletion: Promise<string | null> | undefined;

  /** The messenger reply outcome stored when recovery emitted `completed`. */
  async getStagedOutcomeAtCompletionForTest(): Promise<string | null> {
    return (await this._stagedAtCompletion) ?? null;
  }

  /** A pending reply whose incident settled while nothing was delivering it. */
  async replayOrphanedMessengerDeliveryForTest(): Promise<boolean> {
    const key = `cf_think_messenger_recovery:${crypto.randomUUID()}`;
    await this.ctx.storage.put(key, {
      messengerId: "fake",
      threadId: "fake:dm-orphan",
      partialText: ""
    });
    await (
      this as unknown as {
        _replayMessengerRecoveryDeliveries(): Promise<void>;
      }
    )._replayMessengerRecoveryDeliveries();
    return (await this.ctx.storage.get(key)) === undefined;
  }

  async getAdapterCalls(): Promise<Array<{ kind: string; content: string }>> {
    this._ensureTable();
    return this.sql<{ kind: string; content: string }>`
      SELECT kind, content FROM messenger_delivery_log
      WHERE kind != 'prompt' ORDER BY seq ASC
    `;
  }

  private _ensureTable(): void {
    this.sql`CREATE TABLE IF NOT EXISTS messenger_delivery_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, content TEXT
    )`;
  }

  private _record(kind: string, content: string): void {
    this._ensureTable();
    this.sql`
      INSERT INTO messenger_delivery_log (kind, content)
      VALUES (${kind}, ${content})
    `;
  }

  private _toMessage(webhook: FakeMessengerWebhook): Message {
    const author = webhook.author ?? { fullName: "Ada", userId: "user-ada" };
    return new Message({
      attachments: [],
      author: {
        fullName: author.fullName,
        isBot: false,
        isMe: false,
        userId: author.userId,
        userName: author.fullName.toLowerCase()
      },
      formatted: parseMarkdown(webhook.text),
      id: webhook.id,
      isMention: webhook.isMention,
      metadata: { dateSent: new Date(), edited: false },
      raw: {},
      text: webhook.text,
      threadId: webhook.threadId
    });
  }

  private _recordingAdapter(): Adapter {
    const text = (message: unknown) =>
      typeof message === "string"
        ? message
        : String((message as { markdown?: string }).markdown);
    const adapter = {
      ...fakeAdapter,
      name: "fake",
      editMessage: (threadId: string, _id: string, message: unknown) => {
        this._record("edit", text(message));
        return Promise.resolve({ id: "reply", raw: {}, threadId });
      },
      handleWebhook: async (request: Request) => {
        const body = (await request.json()) as
          | FakeMessengerWebhook
          | FakeMessengerBurstWebhook;
        const deliver = (webhook: FakeMessengerWebhook) =>
          this._chat?.processMessage(
            adapter,
            webhook.threadId,
            this._toMessage(webhook)
          );
        if (!("burst" in body)) {
          await deliver(body);
          return new Response("ok");
        }
        // The rest of the burst must arrive while the first message holds the
        // thread lock, or one of them becomes the leader instead.
        const state = this._chat?.getState();
        const leaderLocked = new Promise<void>((resolve) => {
          if (!state) return resolve();
          const acquireLock = state.acquireLock.bind(state);
          state.acquireLock = async (...args) => {
            state.acquireLock = acquireLock;
            const lock = await acquireLock(...args);
            resolve();
            return lock;
          };
        });
        const [first, ...rest] = body.burst;
        const leader = deliver(first);
        await leaderLocked;
        for (const webhook of rest) {
          await deliver(webhook);
        }
        await leader;
        return new Response("ok");
      },
      initialize: (chat: ChatInstance) => {
        this._chat = chat;
        return Promise.resolve();
      },
      isDM: (threadId: string) => threadId.startsWith("fake:dm"),
      postMessage: (threadId: string, message: unknown) => {
        this._record("post", text(message));
        return Promise.resolve({ id: "reply", raw: {}, threadId });
      },
      startTyping: () => Promise.resolve()
    } as unknown as Adapter;
    return adapter;
  }
}

export class ThinkMessengerRouteTestAgent extends Think {
  override getMessengers(): ThinkMessengers {
    return {
      fake: chatSdkMessenger({
        adapter: fakeAdapter,
        provider: "fake",
        userName: "fake_bot",
        verifyWebhook: false
      })
    };
  }

  override onRequest(_request: Request): Response | Promise<Response> {
    return new Response("fallback");
  }
}
