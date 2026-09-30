import type { LanguageModel, UIMessage } from "ai";
import type { Adapter, Chat, ChatInstance } from "chat";
import { Message, parseMarkdown } from "chat";
import { Think } from "../../think";
import {
  chatSdkMessenger,
  MESSENGER_REPLY_FIBER_NAME,
  messengerReplySnapshot,
  type MessengerEvent,
  type ThinkMessengerRuntime,
  type ThinkMessengers
} from "../../messengers";

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
      async doStream(options: { prompt: unknown }) {
        const prompt = lastUserText(options.prompt);
        record(prompt);
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
        return { stream };
      }
    } as LanguageModel;
  }

  override getMessengers(): ThinkMessengers {
    // #2313: an agent named `queue-…` answers each message as it arrives.
    if (this.name.startsWith("queue-")) this.messengerConcurrency = "queue";
    return {
      fake: chatSdkMessenger({
        adapter: this._recordingAdapter(),
        conversation: this._recoveryMode() === "thread" ? "thread" : "self",
        provider: "fake",
        userName: "fake_bot",
        verifyWebhook: false,
        // A `split-…` agent posts each `|`-separated piece separately.
        ...(this.name.startsWith("split-") && {
          delivery: { splitText: (text: string) => text.split("|") }
        })
      })
    };
  }

  async queueDepthForTest(threadId: string): Promise<number> {
    return (await this._chat?.getState().queueDepth(threadId)) ?? 0;
  }

  /** How the live Chat instance's thread lock is renewed. */
  async lockRenewalForTest(): Promise<{
    maxLockLifetimeMs: number | undefined;
    stateAdapterRenewsLock: boolean | undefined;
  }> {
    const chat = this._chat as
      | (ChatInstance & {
          _concurrencyConfig?: { maxLockLifetimeMs?: number };
        })
      | undefined;
    const state = chat?.getState() as { lockHeartbeat?: boolean } | undefined;
    return {
      maxLockLifetimeMs: chat?._concurrencyConfig?.maxLockLifetimeMs,
      stateAdapterRenewsLock: state?.lockHeartbeat
    };
  }

  async isSubscribedForTest(threadId: string): Promise<boolean> {
    return (await this._chat?.getState().isSubscribed(threadId)) ?? false;
  }

  private _failNextPost = false;

  /**
   * Recovers an interrupted reply while a follow-up sits in the thread's
   * queue, as if the lock holder that would have drained it was evicted.
   * `stage: "streaming"` recovers a reply lost mid-stream, which apologizes;
   * `failPost` fails the recovered reply's first post; `retried` says the
   * caller replays recovery after a failure. Resolves to the recovery error
   * message, if any.
   */
  async recoverWithQueuedFollowUpForTest(options?: {
    enqueue?: boolean;
    failPost?: boolean;
    retried?: boolean;
    stage?: "accepted" | "streaming";
  }): Promise<string | null> {
    const runtime = (
      this as unknown as { _messengerRuntime: ThinkMessengerRuntime }
    )._messengerRuntime;
    const chat = (
      runtime as unknown as { chat: Pick<Chat, "getState" | "initialize"> }
    ).chat;
    await chat.initialize();
    const threadId = "fake:dm-recovered";
    if (options?.enqueue !== false) {
      await chat.getState().enqueue(
        threadId,
        {
          enqueuedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          message: this._toMessage({ id: "f1", text: "follow up", threadId })
        },
        10
      );
    }
    this._failNextPost = options?.failPost ?? false;
    const event: MessengerEvent = {
      capabilities: {},
      kind: "direct-message",
      message: {
        attachments: [],
        author: { fullName: "Ada", userId: "user-ada" },
        id: "r1",
        providerMessageId: "r1",
        text: "hello"
      },
      messengerId: "fake",
      provider: "fake",
      thread: {
        id: threadId,
        isDirectMessage: true,
        providerThreadId: threadId
      }
    };
    try {
      await runtime.handleFiberRecovery(
        {
          createdAt: Date.now(),
          id: "msgr_recovered",
          name: MESSENGER_REPLY_FIBER_NAME,
          recoveryReason: "interrupted",
          snapshot: messengerReplySnapshot(
            options?.stage ?? "accepted",
            event,
            {
              _type: "chat:Thread",
              adapterName: "fake",
              channelId: threadId,
              id: threadId,
              isDM: true
            }
          )
        },
        {
          persistRecoverySnapshot: () => {},
          retriesAfter: () => options?.retried ?? false
        }
      );
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private _failPostForTest: string | null = null;

  /**
   * Deliver a settled recovered reply whose record says `posted` posts
   * already went out, through the live path (`replay: false`) or the start
   * replay. `failPost` rejects that post once. Returns the retry it
   * scheduled, if any, and whether the record is still pending.
   */
  async deliverSettledRecoveryForTest(options: {
    text: string;
    posted?: number;
    failPost?: string;
    replay?: boolean;
  }): Promise<{
    retry: { key: string; attempts: number } | undefined;
    pending: { posted?: number } | undefined;
  }> {
    const incidentId = `${crypto.randomUUID()}:user-1`;
    const key = `cf_think_messenger_recovery:${incidentId}`;
    await this.ctx.storage.put(key, {
      messengerId: "fake",
      threadId: "fake:dm-split",
      partialText: "",
      outcome: "completed",
      text: options.text,
      ...(options.posted !== undefined && { posted: options.posted })
    });
    this._failPostForTest = options.failPost ?? null;
    const internal = this as unknown as {
      _settleMessengerRecovery(
        incidentId: string,
        outcome: "completed" | "interrupted"
      ): void;
      _replayMessengerRecoveryDeliveries(): Promise<void>;
    };
    const retryFor = () =>
      this.getSchedules()
        .filter(
          (schedule) =>
            schedule.callback === "_cfRetryMessengerRecoveryDelivery"
        )
        .map(
          (schedule) =>
            schedule.payload as unknown as { key: string; attempts: number }
        )
        .find((payload) => payload.key === key);
    if (options.replay) {
      await internal._replayMessengerRecoveryDeliveries();
    } else {
      internal._settleMessengerRecovery(incidentId, "completed");
      const deadline = Date.now() + 5_000;
      while (
        Date.now() < deadline &&
        !retryFor() &&
        (await this.ctx.storage.get(key)) !== undefined
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    return {
      retry: retryFor(),
      pending: await this.ctx.storage.get<{ posted?: number }>(key)
    };
  }

  private _slowPostsForTest = false;

  /**
   * Deliver one settled recovered reply from the start replay and a
   * scheduled retry at once, with every post slow enough to overlap.
   */
  async deliverRecoveryConcurrentlyForTest(text: string): Promise<boolean> {
    const key = `cf_think_messenger_recovery:${crypto.randomUUID()}:user-1`;
    await this.ctx.storage.put(key, {
      messengerId: "fake",
      threadId: "fake:dm-split",
      partialText: "",
      outcome: "completed",
      text
    });
    this._slowPostsForTest = true;
    try {
      await Promise.all([
        (
          this as unknown as {
            _replayMessengerRecoveryDeliveries(): Promise<void>;
          }
        )._replayMessengerRecoveryDeliveries(),
        this._cfRetryMessengerRecoveryDelivery({ key, attempts: 1 })
      ]);
    } finally {
      this._slowPostsForTest = false;
    }
    return (await this.ctx.storage.get(key)) === undefined;
  }

  /** Run a scheduled recovered-reply retry now. */
  async runMessengerRecoveryRetryForTest(payload: {
    key: string;
    attempts: number;
  }): Promise<boolean> {
    await this._cfRetryMessengerRecoveryDelivery(payload);
    return (await this.ctx.storage.get(payload.key)) === undefined;
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
  async replayOrphanedMessengerDeliveryForTest(options?: {
    activeIncident?: boolean;
  }): Promise<boolean> {
    const incidentId = `${crypto.randomUUID()}:user-1`;
    if (options?.activeIncident) {
      await this.ctx.storage.put(
        `cf:chat-recovery:incident:${encodeURIComponent(incidentId)}`,
        { incidentId, status: "scheduled" }
      );
    }
    const key = `cf_think_messenger_recovery:${incidentId}`;
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
      postMessage: async (threadId: string, message: unknown) => {
        if (this._failNextPost) {
          this._failNextPost = false;
          throw new Error("post failed");
        }
        if (this._failPostForTest === text(message)) {
          this._failPostForTest = null;
          throw new Error("simulated post failure");
        }
        if (this._slowPostsForTest) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        this._record("post", text(message));
        return { id: "reply", raw: {}, threadId };
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
