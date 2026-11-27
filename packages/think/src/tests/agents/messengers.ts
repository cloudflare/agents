import type { LanguageModel, UIMessage } from "ai";
import type { Adapter, Chat, ChatInstance } from "chat";
import { Message, parseMarkdown } from "chat";
import { Think } from "../../think";
import { releaseDelivery, sendDelivery } from "agents/internal";
import { recoveredReplyId } from "../../messengers/recovered-reply";
import {
  messengerReplySink,
  recoverMessengerReply,
  sendMessengerReply
} from "../../messengers/reply-task";
import { telegramMessenger } from "../../messengers/telegram";
import { messengerChannel } from "../../channels";
import type { ThinkChannels } from "../../channels";
import {
  chatSdkMessenger,
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
      this._stagedAtCompletion = Promise.resolve(
        this._recoveredReplyState(payload.incidentId)
      );
    }
    if (
      type === "chat:recovery:completed" &&
      this._recoveryMode() === "later"
    ) {
      const internal = this as unknown as {
        _cfTranscript: { messages: UIMessage[] };
      };
      internal._cfTranscript.messages = [
        ...internal._cfTranscript.messages,
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

  private _releaseSlowModel = () => {};
  private readonly _slowModelHeld = new Promise<void>((resolve) => {
    this._releaseSlowModel = resolve;
  });

  /** Let a `slow-…` agent's model calls, held and later, run on. */
  releaseSlowModelForTest(): void {
    this._releaseSlowModel();
  }

  override getModel(): LanguageModel {
    const record = (text: string) => this._record("prompt", text);
    const recordEnd = (text: string) => this._record("stream-end", text);
    const mode = this._recoveryMode();
    const nextCall = () => ++this._streamCalls;
    // An agent named `reset-…` resets in its first model call, mid-reply.
    const resetOnce = /^(tg-)?reset-/.test(this.name)
      ? async () => {
          if (this.ctx.storage.kv.get("reset-done")) return;
          this.ctx.storage.kv.put("reset-done", true);
          await this.ctx.storage.sync();
          this.ctx.abort("reset mid-reply");
        }
      : undefined;
    // An agent named `tg-resetmid-…` resets once its first text reached the
    // chat as a draft, mid-answer.
    const bot = this.name;
    const resetMidOnce =
      /^tg-resetmid-/.test(this.name) && !this.ctx.storage.kv.get("reset-done")
        ? async () => {
            this.ctx.storage.kv.put("reset-done", true);
            for (;;) {
              const calls = (await (
                await fetch(`https://fake-telegram.test/__calls?bot=${bot}`)
              ).json()) as Array<{ method: string }>;
              if (calls.some((call) => call.method.includes("Draft"))) break;
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            await this.ctx.storage.sync();
            this.ctx.abort("reset mid-answer");
          }
        : undefined;
    // An agent named `slow-…` holds each model call until the test releases
    // it (`releaseSlowModelForTest`).
    const slow = this.name.startsWith("slow-");
    const held = () => this._slowModelHeld;
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
        await resetOnce?.();
        if (slow) {
          await held();
          recordEnd(prompt);
        }
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
          async start(controller) {
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
            let first = true;
            for (const delta of deltas) {
              controller.enqueue({ type: "text-delta", id: "t", delta });
              if (first && resetMidOnce) await resetMidOnce();
              first = false;
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

  /**
   * An agent named `configured-…` declares its messenger in
   * `configureChannels()` instead of `getMessengers()`.
   */
  override configureChannels(): ThinkChannels {
    if (!this.name.startsWith("configured-")) return {};
    return { fake: messengerChannel(this._messengers().fake) };
  }

  override getMessengers(): ThinkMessengers {
    return this.name.startsWith("configured-") ? {} : this._messengers();
  }

  private _messengers(): ThinkMessengers {
    // #2313: an agent named `queue-…` answers each message as it arrives.
    if (this.name.startsWith("queue-")) this.messengerConcurrency = "queue";
    // An agent named `tg-…` talks to the fake Telegram Bot API (the test
    // config's outbound service), with its name as the bot token.
    if (this.name.startsWith("tg-")) {
      return {
        telegram: telegramMessenger({
          apiBaseUrl: "https://fake-telegram.test",
          token: this.name,
          userName: "probe_bot",
          verifyWebhook: false
        })
      };
    }
    return {
      fake: chatSdkMessenger({
        adapter: this._recordingAdapter(),
        conversation: this._recoveryMode() === "thread" ? "thread" : "self",
        provider: "fake",
        userName: "fake_bot",
        verifyWebhook: false,
        // A `label-…` agent names group speakers its own way.
        ...(this.name.startsWith("label-") && {
          channelSpeakerLabel: (author: { fullName?: string }) =>
            `Speaker ${author.fullName}`
        }),
        // A `split-…` agent posts each `|`-separated piece separately.
        ...(this.name.startsWith("split-") && {
          delivery: { splitText: (text: string) => text.split("|") }
        })
      }),
      // A `two-…` agent has a second messenger, which records its posts.
      ...(this.name.startsWith("two-") && {
        other: chatSdkMessenger({
          adapter: {
            ...fakeAdapter,
            name: "other",
            postMessage: (threadId: string) => {
              this.ctx.storage.kv.put("other-posts", [
                ...this.getOtherPostsForTest(),
                threadId
              ]);
              return Promise.resolve({ id: "other", raw: {}, threadId });
            }
          } as unknown as Adapter,
          provider: "other",
          userName: "fake_bot",
          verifyWebhook: false
        })
      })
    };
  }

  /** Model prompts and slow-mode stream ends, in order. */
  async getModelLog(): Promise<Array<{ kind: string; content: string }>> {
    this._ensureTable();
    return this.sql<{ kind: string; content: string }>`
      SELECT kind, content FROM messenger_delivery_log
      WHERE kind IN ('prompt', 'stream-end') ORDER BY seq ASC
    `;
  }

  async queueDepthForTest(threadId: string): Promise<number> {
    return (await this._chat?.getState().queueDepth(threadId)) ?? 0;
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
    stage?: "accepted" | "streaming" | "completed";
    /** The reply's delivery gives up instead of recovering. */
    giveUp?: boolean;
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
      const payload = {
        event,
        thread: {
          _type: "chat:Thread",
          adapterName: "fake",
          channelId: threadId,
          id: threadId,
          isDM: true
        }
      };
      if (options?.giveUp) {
        // What the delivery module hands its hook: the attempts' checkpoint,
        // where the reply was kept.
        await messengerReplySink(() => runtime).onGiveUp?.(
          new Error("gave up"),
          {},
          {
            get: <T>(key: string) =>
              (key === "reply" ? payload : undefined) as T | undefined
          }
        );
        return null;
      }
      await recoverMessengerReply(
        runtime,
        payload,
        options?.stage ?? "accepted",
        () => {},
        () => options?.retried ?? false
      );
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private _failPostForTest: string | null = null;

  /**
   * Where the incident's recovered reply stands: its released outcome,
   * `"held"` while it waits for one, `"delivered"` once it is gone.
   */
  private _recoveredReplyState(incidentId: string): string {
    const id = recoveredReplyId(incidentId);
    const record = this.tasks.peek(id);
    if (!record) return "delivered";
    return (
      this.tasks.checkpointOf<string>(id, "outcome") ??
      (record.waitReason === "park" ? "held" : "pending")
    );
  }

  /** Wait until the incident's recovered reply is delivered (or 10 s). */
  private async _untilRecoveredReplyDelivered(
    incidentId: string
  ): Promise<boolean> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (this.tasks.peek(recoveredReplyId(incidentId)) === undefined) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  }

  /** A settled reply as the released version kept it. */
  private async _seedLegacyRecoveredReply(
    incidentId: string,
    reply: Record<string, unknown>
  ): Promise<void> {
    await this.ctx.storage.put(`cf_think_messenger_recovery:${incidentId}`, {
      messengerId: "fake",
      threadId: "fake:dm-split",
      partialText: "",
      ...reply
    });
  }

  private _replayRecoveredReplies(): Promise<void> {
    return (
      this as unknown as {
        _replayMessengerRecoveryDeliveries(): Promise<void>;
      }
    )._replayMessengerRecoveryDeliveries();
  }

  /**
   * Deliver a settled recovered reply: one the released version kept with
   * `posted` posts already out, moved on start (`replay: true`), or one
   * held and released by recovery (`replay: false`). `failPost` rejects
   * that post once. Returns whether the delivery then waits to retry, and
   * its cursor.
   */
  async deliverSettledRecoveryForTest(options: {
    text: string;
    posted?: number;
    failPost?: string;
    replay?: boolean;
  }): Promise<{
    incidentId: string;
    retrying: boolean;
    posted: number | undefined;
    delivered: boolean;
  }> {
    const incidentId = `${crypto.randomUUID()}:user-1`;
    const id = recoveredReplyId(incidentId);
    this._failPostForTest = options.failPost ?? null;
    if (options.replay) {
      await this._seedLegacyRecoveredReply(incidentId, {
        outcome: "completed",
        text: options.text,
        ...(options.posted !== undefined && { posted: options.posted })
      });
      await this._replayRecoveredReplies();
    } else {
      await sendDelivery(this.tasks, "think-messenger-recovery", id, {
        messengerId: "fake",
        threadId: "fake:dm-split",
        partialText: ""
      });
      await releaseDelivery(this.tasks, id, {
        outcome: "completed",
        text: options.text
      });
    }
    // Until it is delivered, or an attempt that posted failed and waits.
    const deadline = Date.now() + 5_000;
    while (
      Date.now() < deadline &&
      this.tasks.peek(id) !== undefined &&
      (this.tasks.peek(id)?.waitReason !== "retry" ||
        this.tasks.checkpointOf(id, "posted") === undefined)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return {
      incidentId,
      retrying: this.tasks.peek(id)?.waitReason === "retry",
      posted: this.tasks.checkpointOf<number>(id, "posted"),
      delivered: this.tasks.peek(id) === undefined
    };
  }

  private _slowPostsForTest = false;

  /**
   * Release one held recovered reply twice at once, and run the start
   * replay beside it, with every post slow enough to overlap.
   */
  async deliverRecoveryConcurrentlyForTest(text: string): Promise<boolean> {
    const incidentId = `${crypto.randomUUID()}:user-1`;
    const id = recoveredReplyId(incidentId);
    await sendDelivery(this.tasks, "think-messenger-recovery", id, {
      messengerId: "fake",
      threadId: "fake:dm-split",
      partialText: ""
    });
    this._slowPostsForTest = true;
    try {
      const outcome = { outcome: "completed", text };
      await Promise.all([
        releaseDelivery(this.tasks, id, outcome),
        releaseDelivery(this.tasks, id, outcome),
        this._replayRecoveredReplies()
      ]);
      return await this._untilRecoveredReplyDelivered(incidentId);
    } finally {
      this._slowPostsForTest = false;
    }
  }

  /** Wait for a recovered reply that waits to retry to be delivered. */
  async awaitRecoveredReplyForTest(incidentId: string): Promise<boolean> {
    return this._untilRecoveredReplyDelivered(incidentId);
  }

  async getRecorded(kind: "prompt" | "post" | "edit"): Promise<string[]> {
    this._ensureTable();
    return this.sql<{ content: string }>`
      SELECT content FROM messenger_delivery_log
      WHERE kind = ${kind} ORDER BY seq ASC
    `.map((row) => row.content);
  }

  private _stagedAtCompletion: Promise<string | null> | undefined;

  /** Where the reply stood when recovery emitted `completed`. */
  async getStagedOutcomeAtCompletionForTest(): Promise<string | null> {
    return (await this._stagedAtCompletion) ?? null;
  }

  /**
   * A reply the released version kept unsettled, moved on start: delivered
   * as `interrupted` when its incident is gone, held while it recovers.
   */
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
    await this._seedLegacyRecoveredReply(incidentId, {
      threadId: "fake:dm-orphan"
    });
    await this._replayRecoveredReplies();
    if (options?.activeIncident) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return this.tasks.peek(recoveredReplyId(incidentId)) === undefined;
    }
    return this._untilRecoveredReplyDelivered(incidentId);
  }

  /**
   * A reply the released version kept unsettled while its incident still
   * recovers, moved on start, then released by recovery before any alarm
   * ran: it must be held at once so the release finds it.
   */
  async releaseMigratedRecoveringReplyForTest(text: string): Promise<{
    heldAfterStart: boolean;
    delivered: boolean;
  }> {
    const incidentId = `${crypto.randomUUID()}:user-1`;
    await this.ctx.storage.put(
      `cf:chat-recovery:incident:${encodeURIComponent(incidentId)}`,
      { incidentId, status: "scheduled" }
    );
    await this._seedLegacyRecoveredReply(incidentId, {});
    await this._replayRecoveredReplies();
    const heldAfterStart =
      this.tasks.peek(recoveredReplyId(incidentId))?.waitReason === "park";
    await (
      this as unknown as {
        _releaseMessengerRecovery(
          incidentId: string,
          outcome: "completed" | "interrupted",
          text?: string
        ): Promise<void>;
      }
    )._releaseMessengerRecovery(incidentId, "completed", text);
    return {
      heldAfterStart,
      delivered: await this._untilRecoveredReplyDelivered(incidentId)
    };
  }

  /**
   * A reply run think@0.24.0 left interrupted: its snapshot in the storage
   * key that release wrote, its run replayed with no live reply. Returns
   * whether the key is gone afterwards.
   */
  async replayReleasedReplyForTest(
    stage: "accepted" | "completed" = "accepted"
  ): Promise<boolean> {
    const nonce = crypto.randomUUID();
    const threadId = "fake:dm-released";
    const event: MessengerEvent = {
      capabilities: {},
      kind: "direct-message",
      message: {
        attachments: [],
        author: { fullName: "Ada", userId: "user-ada" },
        createdAt: new Date(0),
        id: "rel1",
        providerMessageId: "rel1",
        text: "released hello"
      },
      messengerId: "fake",
      provider: "fake",
      thread: {
        id: threadId,
        isDirectMessage: true,
        providerThreadId: threadId
      }
    };
    const key = `__cf_messenger_recovery:msgr_${nonce}`;
    await this.ctx.storage.put(
      key,
      // The snapshot as think@0.24.0 wrote it.
      {
        type: "think:messenger-reply",
        stage,
        tag: { stage, kind: "interim", turnEnded: false },
        event,
        thread: {
          _type: "chat:Thread",
          adapterName: "fake",
          channelId: threadId,
          id: threadId,
          isDM: true
        }
      }
    );
    await this.tasks.run(
      "__cf_internal_messenger_reply",
      { nonce },
      { runId: `msgr_${nonce}`, start: "now" }
    );
    return (await this.ctx.storage.get(key)) === undefined;
  }

  /**
   * Sends the same reply id twice, the second after the first was
   * answered; returns how many times it was answered.
   */
  async sendReplyTwiceForTest(): Promise<number> {
    let answered = 0;
    const id = `repeat-${crypto.randomUUID()}`;
    const send = () =>
      sendMessengerReply(this.tasks, id, {
        payload: { event: {} as MessengerEvent, thread: null },
        answer: async () => {
          answered++;
        }
      });
    await send();
    await send();
    return answered;
  }

  /** Whether any kept reply run's row still holds `text`. */
  async replyRowsHoldForTest(text: string): Promise<boolean> {
    const rows = this.sql<Record<string, unknown>>`
      SELECT * FROM cf_agents_task_runs
      WHERE definition = '__cf_delivery:messenger-reply'
    `;
    if (rows.length === 0) throw new Error("no reply run kept");
    return JSON.stringify(rows).includes(text);
  }

  /** Messenger reply runs not yet settled. */
  async openReplyRunsForTest(): Promise<number> {
    return (
      this.sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM cf_agents_task_runs
        WHERE (
          definition IN (
            '__cf_internal_messenger_reply', '__cf_delivery:messenger-reply'
          )
          -- The harness-backed Think sends replies through Channels.
          OR definition LIKE '__cf_delivery:channels:%'
        )
          AND status IN ('pending', 'running')
      `[0]?.n ?? 0
    );
  }

  async getAdapterCalls(): Promise<Array<{ kind: string; content: string }>> {
    this._ensureTable();
    return this.sql<{ kind: string; content: string }>`
      SELECT kind, content FROM messenger_delivery_log
      WHERE kind != 'prompt' ORDER BY seq ASC
    `;
  }

  /** Deliver a notice out of a turn; returns the transcript's texts. */
  async deliverNoticeForTest(
    text: string,
    options: { channel: string; thread: string; informModel?: boolean }
  ): Promise<string[]> {
    await this.deliverNotice(text, options);
    return (await this.getMessages()).flatMap((message) =>
      message.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
    );
  }

  private _ensureTable(): void {
    this.sql`CREATE TABLE IF NOT EXISTS messenger_delivery_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, content TEXT
    )`;
  }

  /** The threads the `two-…` agent's second messenger posted to. */
  getOtherPostsForTest(): string[] {
    return this.ctx.storage.kv.get<string[]>("other-posts") ?? [];
  }

  /** Askers the harness-backed Think still keeps for its turns. */
  askersKeptForTest(): number {
    return [
      ...this.ctx.storage.kv.list({ prefix: "cf_think_messenger_asker:" })
    ].length;
  }

  /** A notice to a messenger with no thread; returns the error's text. */
  async deliverNoticeWithoutThreadForTest(): Promise<string> {
    try {
      await this.deliverNotice("hi", { channel: "fake" });
      return "delivered";
    } catch (error) {
      return String(error);
    }
  }

  /** Whether each post was plain text or Markdown, in order. */
  getPostShapesForTest(): string[] {
    return this.ctx.storage.kv.get<string[]>("post-shapes") ?? [];
  }

  /** The thread of every post, in order. */
  getPostThreadsForTest(): string[] {
    return this.ctx.storage.kv.get<string[]>("post-threads") ?? [];
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
        if (this.name.startsWith("slow-")) {
          // Stand-in for the Chat SDK's fixed 30s lock: short enough that a
          // slow turn outlives it unless the lock is kept alive, long enough
          // that a loaded runner's stalls do not starve the heartbeat.
          const state = chat.getState();
          const acquireLock = state.acquireLock.bind(state);
          const extendLock = state.extendLock.bind(state);
          state.acquireLock = (threadId, ttlMs) =>
            acquireLock(threadId, Math.min(ttlMs, 1000));
          state.extendLock = (lock, ttlMs) =>
            extendLock(lock, Math.min(ttlMs, 1000));
        }
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
        this.ctx.storage.kv.put("post-threads", [
          ...this.getPostThreadsForTest(),
          threadId
        ]);
        this.ctx.storage.kv.put("post-shapes", [
          ...(this.ctx.storage.kv.get<string[]>("post-shapes") ?? []),
          typeof message === "string" ? "text" : "markdown"
        ]);
        return { id: "reply", raw: {}, threadId };
      },
      startTyping: () => Promise.resolve()
    } as unknown as Adapter;
    return adapter;
  }
}

/** Webhooks the guarded messenger's adapter handled, in this isolate. */
let guardedWebhooks = 0;

export class ThinkMessengerRouteTestAgent extends Think {
  getGuardedWebhooksForTest(): number {
    return guardedWebhooks;
  }

  override getMessengers(): ThinkMessengers {
    return {
      fake: chatSdkMessenger({
        adapter: fakeAdapter,
        provider: "fake",
        userName: "fake_bot",
        verifyWebhook: false
      }),
      guarded: chatSdkMessenger({
        adapter: {
          ...fakeAdapter,
          handleWebhook: () => {
            guardedWebhooks += 1;
            return Promise.resolve(new Response("guarded"));
          }
        } as unknown as typeof fakeAdapter,
        adapterName: "guarded",
        provider: "fake",
        userName: "fake_bot",
        verifyWebhook: () => false
      })
    };
  }

  /** A messenger webhook sent to a sub-agent of this class. */
  async webhookOnSubAgentForTest(): Promise<string> {
    // A sub-agent's stub takes fetch, though its type does not say so.
    const child = (await this.subAgent(
      ThinkMessengerRouteTestAgent,
      "kid"
    )) as unknown as {
      fetch(url: string, init: RequestInit): Promise<Response>;
    };
    const response = await child.fetch(
      "https://example.com/messengers/fake/webhook",
      { method: "POST" }
    );
    return response.text();
  }

  override onRequest(_request: Request): Response | Promise<Response> {
    return new Response("fallback");
  }
}
