import type { UIMessage } from "ai";
import type {
  Adapter,
  ActionEvent as ChatActionEvent,
  Attachment as ChatAttachment,
  Author as ChatAuthor,
  ChatConfig,
  ConcurrencyConfig,
  ConcurrencyStrategy,
  Lock as ChatLock,
  Message as ChatMessage,
  SerializedThread,
  Thread as ChatThread
} from "chat";
import { Chat, Message, ThreadImpl } from "chat";
import type {
  Agent,
  FiberContext,
  FiberRecoveryResult,
  StartFiberOptions,
  SubAgentClass,
  SubAgentStub
} from "agents";
import { createChatSdkState, defaultKeyShard } from "agents/chat-sdk";
import type { ChatSdkStateAdapterOptions } from "agents/chat-sdk";
import { ChatSdkStateAgent } from "agents/chat-sdk";
import type { StreamCallback } from "../think";
import type {
  LiveMessengerReply,
  MessengerReplyPayload,
  RecordReplyStage
} from "./reply-task";
import type {
  MessengerAttachment,
  MessengerAction,
  MessengerAuthor,
  MessengerCapabilities,
  MessengerEvent,
  MessengerEventKind,
  MessengerMessage,
  MessengerThread
} from "./events";
import {
  serializableMessengerEvent,
  toMessengerUserMessage,
  type ChannelSpeakerLabel
} from "./events";
import {
  deliverMessengerReply,
  EMPTY_MESSENGER_RESPONSE,
  INTERRUPTED_MESSENGER_RESPONSE,
  messengerReplyRecoveryMode,
  reviveMessengerEvent,
  type MessengerReplyStage,
  type MessengerDeliveryPolicy,
  type MessengerDeliverySurface,
  type MessengerDeliveryTarget
} from "./delivery";

export class ThinkMessengerStateAgent extends ChatSdkStateAgent {}

/**
 * Adapters without native streaming would otherwise post `"..."` and edit it,
 * and platforms such as Slack keep that first text as the notification
 * preview. Delivery already shows a typing indicator before the reply starts.
 */
const FALLBACK_STREAMING_PLACEHOLDER_TEXT = null;

/** The posts that deliver a recovered messenger reply, in order. */
function recoveredReplyPosts(
  definition: { delivery?: MessengerDeliveryPolicy },
  input: {
    outcome: "completed" | "interrupted";
    text?: string;
    partialPosted?: boolean;
  }
): Array<string | { markdown: string }> {
  if (input.outcome === "interrupted") {
    return [
      definition.delivery?.interruptedResponseText ??
        INTERRUPTED_MESSENGER_RESPONSE
    ];
  }
  const text = input.text?.trim() ? input.text : "";
  if (!text) {
    return input.partialPosted
      ? []
      : [definition.delivery?.emptyResponseText ?? EMPTY_MESSENGER_RESPONSE];
  }
  return (definition.delivery?.splitText?.(text) ?? [text]).map((chunk) => ({
    markdown: chunk
  }));
}

export type MessengerRespondTo =
  | "action"
  | "direct-message"
  | "mention"
  | "subscribed-thread";

export type MessengerConversationMode = "self" | "thread";

export type MessengerConversationTarget =
  | { target: "self" }
  | {
      agentClass?: SubAgentClass<Agent & MessengerThinkTarget>;
      name: string;
      target: "subagent";
    };

export type MessengerConversationResolver = (
  event: MessengerEvent
) => MessengerConversationTarget | Promise<MessengerConversationTarget>;

export interface MessengerDefinition {
  adapter: Adapter;
  adapterName: string;
  capabilities?: MessengerCapabilities;
  /**
   * Customizes how non-DM channel messages are labelled for the model.
   *
   * Channel (group) messages use `fullName || userName || userId` by default and
   * are rendered as `SpeakerName: text` so the model can attribute multi-user
   * traffic. Direct messages never get a prefix.
   */
  channelSpeakerLabel?: ChannelSpeakerLabel;
  conversation?: MessengerConversationMode | MessengerConversationResolver;
  delivery?: MessengerDeliveryPolicy;
  keyShard?: ChatSdkStateAdapterOptions["keyShard"];
  path?: string;
  provider: string;
  respondTo?: readonly MessengerRespondTo[];
  shardKey?: ChatSdkStateAdapterOptions["shardKey"];
  subscribeOnMention?: boolean;
  toEvent?: (
    input: ChatSdkMessengerEventInput
  ) => MessengerEvent | Promise<MessengerEvent>;
  userName: string;
  verifyWebhook?:
    | false
    | ((request: Request) => boolean | Response | Promise<boolean | Response>);
}

export type ThinkMessengers = Record<string, MessengerDefinition>;

/** The Chat SDK `concurrency` setting for a Think agent's messengers. */
export type MessengerConcurrency = ConcurrencyStrategy | ConcurrencyConfig;

/**
 * How long a message queued behind a running reply stays answerable. The
 * Chat SDK default (90 seconds) drops follow-ups sent early in a long turn,
 * so Think applies this unless `queueEntryTtlMs` is set explicitly.
 */
const MESSENGER_QUEUE_ENTRY_TTL_MS = 30 * 60 * 1000;

export const DEFAULT_MESSENGER_CONCURRENCY: MessengerConcurrency = {
  debounceMs: 600,
  queueEntryTtlMs: MESSENGER_QUEUE_ENTRY_TTL_MS,
  strategy: "burst"
};

/** The Chat SDK's thread lock TTL (`DEFAULT_LOCK_TTL_MS`). */
const CHAT_SDK_LOCK_TTL_MS = 30_000;

/**
 * Private `Chat` methods the post-recovery drain reuses so a stranded queue
 * is dispatched exactly as the SDK would (lock scope, expiry, `skipped`).
 * Feature-checked at runtime: a `chat` release without them skips the drain.
 */
interface ChatSdkQueueInternals {
  getLockKey(adapter: Adapter, threadId: string): Promise<string>;
  drainQueue(
    lock: ChatLock,
    adapter: Adapter,
    threadId: string,
    lockKey: string
  ): Promise<void>;
}

/** Fill in Think's queue-entry TTL where the setting leaves it unset. */
export function withMessengerQueueTtl(
  concurrency: MessengerConcurrency
): MessengerConcurrency {
  if (typeof concurrency === "string") {
    return {
      queueEntryTtlMs: MESSENGER_QUEUE_ENTRY_TTL_MS,
      strategy: concurrency
    };
  }
  return {
    ...concurrency,
    queueEntryTtlMs: concurrency.queueEntryTtlMs ?? MESSENGER_QUEUE_ENTRY_TTL_MS
  };
}

export interface NormalizedMessengerDefinition extends MessengerDefinition {
  id: string;
  path: string;
  respondTo: readonly MessengerRespondTo[];
  subscribeOnMention: boolean;
  verifyWebhook:
    | false
    | ((request: Request) => boolean | Response | Promise<boolean | Response>);
}

export interface ChatSdkMessengerOptions extends Omit<
  MessengerDefinition,
  "adapterName"
> {
  adapterName?: string;
}

export interface ChatSdkMessengerEventInput {
  action?: ChatActionEvent;
  eventKind: MessengerEventKind;
  message?: ChatMessage;
  raw?: unknown;
  /**
   * Earlier messages the Chat SDK's concurrency strategy folded into this one,
   * oldest first (`MessageContext.skipped`). The runtime's `burst` strategy
   * answers only the newest message of a quick run and reports the rest here.
   * {@link defaultChatSdkEvent} carries them on the event's `skipped` so they
   * reach the model; a custom `toEvent` that ignores them drops them.
   */
  skipped?: readonly ChatMessage[];
  thread: ChatThread;
}

export interface MessengerThinkTarget {
  cancelChat(
    requestId: string,
    reason?: string
  ): boolean | void | Promise<boolean | void>;
  chat(
    userMessage: string | UIMessage,
    callback: StreamCallback
  ): Promise<void>;
  chatWithMessengerContext?(
    userMessage: string | UIMessage,
    callback: StreamCallback,
    context: MessengerEvent
  ): Promise<void>;
}

export interface MessengerThinkHost extends MessengerThinkTarget {
  constructor: { name: string };
  name: string;
  parentPath: ReadonlyArray<{ className: string; name: string }>;
  startFiber(
    name: string,
    fn: (ctx: FiberContext) => Promise<void>,
    options?: StartFiberOptions
  ): Promise<MessengerFiberStartResult>;
  resolveFiber(id: string, result: FiberRecoveryResult): Promise<boolean>;
  /**
   * Durably accept one messenger reply as a delivery and answer it inline
   * while this isolate lives. The same id joins a reply still running.
   */
  _sendMessengerReply(id: string, live: LiveMessengerReply): Promise<void>;
  subAgent<T extends Agent>(
    agentClass: SubAgentClass<T>,
    name: string
  ): Promise<SubAgentStub<T>>;
  /** Keep the host alive while background messenger work runs. */
  keepAliveWhile?<T>(fn: () => Promise<T>): Promise<T>;
}

interface MessengerFiberStartResult {
  accepted: boolean;
  fiberId: string;
  snapshot?: unknown;
  status: string;
}

export function chatSdkMessenger(
  options: ChatSdkMessengerOptions
): MessengerDefinition {
  return {
    ...options,
    adapterName: options.adapterName ?? options.provider
  };
}

export class ThinkMessengerRuntime {
  private chat?: Chat<Record<string, Adapter>>;
  private readonly definitionsById = new Map<
    string,
    NormalizedMessengerDefinition
  >();
  private readonly definitions: NormalizedMessengerDefinition[];

  private readonly concurrency: MessengerConcurrency;

  constructor(
    definitions: ThinkMessengers,
    private readonly host: MessengerThinkHost,
    options?: { concurrency?: MessengerConcurrency }
  ) {
    this.concurrency = withMessengerQueueTtl(
      options?.concurrency ?? DEFAULT_MESSENGER_CONCURRENCY
    );
    this.definitions = normalizeMessengers(definitions);
    for (const definition of this.definitions) {
      this.definitionsById.set(definition.id, definition);
    }
  }

  get size(): number {
    return this.definitions.length;
  }

  initialize(): void {
    if (this.host.parentPath.length > 0) {
      return;
    }

    this.chat = this.createChat();
  }

  async handleRequest(request: Request): Promise<Response | undefined> {
    if (this.host.parentPath.length > 0) {
      return undefined;
    }

    const url = new URL(request.url);
    const definition = this.definitions.find(
      (candidate) => candidate.path === url.pathname
    );
    if (!definition) {
      return undefined;
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    if (definition.verifyWebhook !== false) {
      const verification = await definition.verifyWebhook(
        request.clone() as Request
      );
      if (verification instanceof Response) {
        return verification;
      }
      if (verification === false) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    const chat = this.chat ?? this.createChat();
    this.chat = chat;
    return chat.webhooks[definition.adapterName](request);
  }

  /**
   * Answer again, or apologize, for a reply a reset cut off at `stage`.
   *
   * @internal
   */
  async recoverReply(
    payload: MessengerReplyPayload,
    stage: MessengerReplyStage,
    record: RecordReplyStage
  ): Promise<void> {
    const event = reviveMessengerEvent(payload.event);
    const definition = this.definitionsById.get(event.messengerId);
    if (!definition) {
      throw new Error(
        `No messenger definition found for recovered messenger ${event.messengerId}`
      );
    }
    const thread = this.reviveThread(definition, payload.thread);
    const mode = messengerReplyRecoveryMode(stage);
    if (mode === "answer") {
      await this.answer(definition, event, thread, record, event);
      return;
    }
    if (mode === "apologize") {
      await thread.post(
        definition.delivery?.interruptedResponseText ??
          INTERRUPTED_MESSENGER_RESPONSE
      );
      record("completed");
    }
  }

  /**
   * After a recovered reply ended or gave up, answer the messages queued
   * behind it.
   *
   * @internal
   */
  drainAfterRecovery(payload: MessengerReplyPayload): void {
    const definition = this.definitionsById.get(payload.event.messengerId);
    if (!definition) return;
    const thread = this.reviveThread(definition, payload.thread);
    this.drainQueuedMessagesInBackground(definition, thread.id);
  }

  /**
   * Messages queued behind a reply are drained only by the Chat SDK handler
   * holding the thread lock. When the isolate running that reply dies, the
   * queue is stranded until another message arrives, so recovery drains it:
   * once the dead holder's lock expires, take the lock and hand the queue to
   * the SDK's own drain. A live holder drains the queue itself, which ends
   * the wait.
   */
  private drainQueuedMessagesInBackground(
    definition: NormalizedMessengerDefinition,
    threadId: string
  ): void {
    const drain = () => this.drainQueuedMessages(definition, threadId);
    const running = this.host.keepAliveWhile?.(drain) ?? drain();
    void running.catch((error: unknown) => {
      console.error(
        `[Think] Failed to drain messages queued on ${threadId} after recovery`,
        error
      );
    });
  }

  private async drainQueuedMessages(
    definition: NormalizedMessengerDefinition,
    threadId: string
  ): Promise<void> {
    const chat = (this.chat ??= this.createChat());
    const internals = chat as unknown as Partial<ChatSdkQueueInternals>;
    if (
      typeof internals.getLockKey !== "function" ||
      typeof internals.drainQueue !== "function"
    ) {
      return;
    }
    await chat.initialize();
    const state = chat.getState();
    const lockKey = await internals.getLockKey.call(
      chat,
      definition.adapter,
      threadId
    );
    const deadline = Date.now() + CHAT_SDK_LOCK_TTL_MS + 5_000;
    while ((await state.queueDepth(lockKey)) > 0) {
      const lock = await state.acquireLock(lockKey, CHAT_SDK_LOCK_TTL_MS);
      if (lock) {
        try {
          await internals.drainQueue.call(
            chat,
            lock,
            definition.adapter,
            threadId,
            lockKey
          );
        } finally {
          await state.releaseLock(lock);
        }
        return;
      }
      if (Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  private createChat(): Chat<Record<string, Adapter>> {
    return createMessengerChat({
      definitions: this.definitions,
      concurrency: this.concurrency,
      parent: this.host,
      onEvent: (definition, event, thread) =>
        this.enqueueReply(definition, event, thread)
    });
  }

  private async enqueueReply(
    definition: NormalizedMessengerDefinition,
    event: MessengerEvent,
    thread: ChatThread
  ): Promise<void> {
    const snapshotEvent = serializableMessengerEvent(event);
    // Durable acceptance plus inline execution, as one delivery. A
    // duplicate webhook joins a reply still running; a reply a reset cut
    // off is answered again or apologized for on wake, by its stage.
    await this.host._sendMessengerReply(idempotencyKeyForEvent(event), {
      payload: { event: snapshotEvent, thread: thread.toJSON() },
      answer: (record) =>
        this.answer(definition, event, thread, record, snapshotEvent)
    });
  }

  private async answer(
    definition: NormalizedMessengerDefinition,
    event: MessengerEvent,
    thread: ChatThread,
    record?: RecordReplyStage,
    snapshotEvent = serializableMessengerEvent(event)
  ): Promise<void> {
    const target = await this.resolveTarget(definition, event);
    await deliverMessengerReply({
      event,
      ...(record && { onStage: record }),
      policy: definition.delivery,
      snapshotEvent,
      surface: thread satisfies MessengerDeliverySurface,
      target,
      userMessage: toMessengerUserMessage(event, definition.channelSpeakerLabel)
    });
  }

  /**
   * Resolve a live delivery surface for an out-of-turn notice (e.g. a scheduled
   * task or webhook handler calling `deliverNotice`). Uses `chat.thread(id)` —
   * the chat SDK's supported "post from outside a webhook" primitive, which
   * returns a postable {@link ChatThread} and infers the adapter from the
   * thread-id prefix, so it works for every chat-sdk adapter with no per-adapter
   * wiring. Returns `undefined` when the channel is unregistered or no `threadId`
   * was supplied so the caller can fail fast.
   */
  async resolveDeliverySurface(
    channelId: string,
    threadId?: string
  ): Promise<MessengerDeliverySurface | undefined> {
    const definition = this.definitionsById.get(channelId);
    if (!definition || !threadId) {
      return undefined;
    }
    const chat = this.chat ?? this.createChat();
    return chat.thread(threadId) satisfies MessengerDeliverySurface;
  }

  /**
   * Post what chat recovery produced for an interrupted messenger turn: the
   * text the thread has not seen yet, or the interrupted apology when
   * recovery gave up. The reply may span several posts; this posts only post
   * number `chunk` (skipped when out of range) and returns how many there
   * are, so the caller can checkpoint between posts.
   */
  async deliverRecoveredReply(input: {
    messengerId: string;
    threadId: string;
    outcome: "completed" | "interrupted";
    text?: string;
    partialPosted?: boolean;
    chunk: number;
  }): Promise<{ chunks: number }> {
    const definition = this.definitionsById.get(input.messengerId);
    const surface = await this.resolveDeliverySurface(
      input.messengerId,
      input.threadId
    );
    if (!definition || !surface) {
      throw new Error(
        `No messenger delivery surface for ${input.messengerId} thread ${input.threadId}`
      );
    }
    const posts = recoveredReplyPosts(definition, input);
    const post = posts[input.chunk];
    if (post !== undefined) await surface.post(post);
    return { chunks: posts.length };
  }

  private async resolveTarget(
    definition: NormalizedMessengerDefinition,
    event: MessengerEvent
  ): Promise<MessengerDeliveryTarget> {
    const conversation = definition.conversation ?? "thread";
    const target =
      typeof conversation === "function"
        ? await conversation(event)
        : conversation === "self"
          ? { target: "self" as const }
          : {
              name: defaultConversationName(event),
              target: "subagent" as const
            };

    if (target.target === "self") {
      return this.host;
    }

    const agentClass =
      target.agentClass ??
      (this.host.constructor as unknown as SubAgentClass<
        Agent & MessengerThinkTarget
      >);
    const stub = (await this.host.subAgent(
      agentClass,
      target.name
    )) as unknown as Required<MessengerThinkTarget>;
    // A live thread cannot cross the sub-agent RPC boundary, so the stub's
    // `bindActiveDeliverySurface` must not be offered to delivery.
    return {
      cancelChat: (requestId, reason) => stub.cancelChat(requestId, reason),
      chat: (userMessage, callback) => stub.chat(userMessage, callback),
      chatWithMessengerContext: (userMessage, callback, context) =>
        stub.chatWithMessengerContext(userMessage, callback, context)
    };
  }

  /**
   * `ThreadImpl.fromJSON` (what `chat.reviver()` calls) builds the thread
   * without the Chat's streaming config, so a recovered reply would fall back to
   * the `"..."` placeholder. Rebuild it from the same fields with that config.
   */
  private reviveThread(
    definition: NormalizedMessengerDefinition,
    value: unknown
  ): ChatThread {
    if (value === undefined) {
      throw new Error(
        "Messenger recovery snapshot is missing chat object data"
      );
    }
    const chat = (this.chat ??= this.createChat());
    const json = JSON.parse(JSON.stringify(value)) as SerializedThread;
    // Bound explicitly: a lazy thread resolves its adapter from the
    // module-global Chat singleton on first use, which another runtime in
    // this isolate can replace while recovery awaits.
    return new ThreadImpl({
      adapter: definition.adapter,
      stateAdapter: chat.getState(),
      channelId: json.channelId,
      channelVisibility: json.channelVisibility,
      currentMessage: json.currentMessage
        ? Message.fromJSON(json.currentMessage)
        : undefined,
      fallbackStreamingPlaceholderText: FALLBACK_STREAMING_PLACEHOLDER_TEXT,
      id: json.id,
      isDM: json.isDM
    });
  }
}

/**
 * The Chat SDK `Chat` a Think's messengers take their webhooks through: its
 * state on Think's state sub-agents (subscriptions, thread locks, queued
 * messages), its concurrency, and the handlers that turn what each
 * messenger answers (`respondTo`) into a {@link MessengerEvent} for
 * `onEvent`. A handler holds the thread's lock until `onEvent` resolves.
 *
 * @internal
 */
export function createMessengerChat(options: {
  definitions: NormalizedMessengerDefinition[];
  concurrency: MessengerConcurrency;
  parent: unknown;
  onEvent(
    definition: NormalizedMessengerDefinition,
    event: MessengerEvent,
    thread: ChatThread
  ): Promise<void>;
}): Chat<Record<string, Adapter>> {
  const { definitions } = options;
  const lookup = messengerLookup(definitions);
  const adapters = Object.fromEntries(
    definitions.map((definition) => [
      definition.adapterName,
      definition.adapter
    ])
  ) as Record<string, Adapter>;
  const chat = new Chat({
    adapters,
    concurrency: options.concurrency,
    fallbackStreamingPlaceholderText: FALLBACK_STREAMING_PLACEHOLDER_TEXT,
    state: createChatSdkState({
      agent: ThinkMessengerStateAgent,
      keyShard: (key) => lookup.shardStateKey(key),
      // The Chat SDK never extends its 30 second thread lock while a
      // handler runs; a Think turn often takes longer.
      lockHeartbeat: true,
      parent: options.parent as ChatSdkStateAdapterOptions["parent"],
      shardKey: (threadId) => lookup.shardThread(threadId)
    }),
    userName: definitions[0]?.userName ?? "think"
  } satisfies ChatConfig<Record<string, Adapter>>);

  chat.onDirectMessage(async (thread, message, _channel, context) => {
    const definition = lookup.forThread(thread);
    if (!definition) return;
    if (definition.respondTo.includes("direct-message")) {
      await options.onEvent(
        definition,
        await messengerEvent(definition, {
          eventKind: "direct-message",
          message,
          skipped: context?.skipped,
          thread
        }),
        thread
      );
    }
  });

  chat.onNewMention(async (thread, message, context) => {
    const definition = lookup.forThread(thread);
    if (!definition) return;
    if (definition.subscribeOnMention) {
      await thread.subscribe();
    }
    if (definition.respondTo.includes("mention")) {
      await options.onEvent(
        definition,
        await messengerEvent(definition, {
          eventKind: "mention",
          message,
          skipped: context?.skipped,
          thread
        }),
        thread
      );
    }
  });

  // A burst is routed on its newest message only. When an earlier message
  // in an unsubscribed thread mentioned the bot, answer the burst as that
  // mention instead of letting it fall through unanswered.
  chat.onNewMessage(/[\s\S]*/, async (thread, message, context) => {
    const definition = lookup.forThread(thread);
    if (!definition || !definition.respondTo.includes("mention")) return;
    if (!context?.skipped.some((skipped) => mentionsBot(definition, skipped)))
      return;
    if (definition.subscribeOnMention) {
      await thread.subscribe();
    }
    await options.onEvent(
      definition,
      await messengerEvent(definition, {
        eventKind: "mention",
        message,
        skipped: context.skipped,
        thread
      }),
      thread
    );
  });

  chat.onSubscribedMessage(async (thread, message, context) => {
    const definition = lookup.forThread(thread);
    if (!definition) return;
    const mentioned =
      message.isMention ||
      (context?.skipped.some((skipped) => mentionsBot(definition, skipped)) ??
        false);
    if (
      definition.respondTo.includes("subscribed-thread") ||
      (mentioned && definition.respondTo.includes("mention"))
    ) {
      await options.onEvent(
        definition,
        await messengerEvent(definition, {
          eventKind: mentioned ? "mention" : "subscribed-message",
          message,
          skipped: context?.skipped,
          thread
        }),
        thread
      );
    }
  });

  chat.onAction(async (event) => {
    if (!event.thread) return;
    const thread = event.thread as ChatThread;
    const definition = lookup.forThread(thread);
    if (!definition) return;
    if (definition.respondTo.includes("action")) {
      await options.onEvent(
        definition,
        await messengerEvent(definition, {
          action: event,
          eventKind: "action",
          raw: event.raw,
          thread
        }),
        thread
      );
    }
  });

  return chat.registerSingleton();
}

/** Which messenger a thread or a state key belongs to. */
function messengerLookup(definitions: NormalizedMessengerDefinition[]) {
  const byAdapterName = new Map(
    definitions.map((definition) => [definition.adapterName, definition])
  );
  const hasUniqueProvider = (provider: string): boolean =>
    definitions.filter((definition) => definition.provider === provider)
      .length === 1;
  const forThreadId = (
    threadId: string | undefined
  ): NormalizedMessengerDefinition | undefined => {
    if (!threadId) return undefined;
    if (definitions.length === 1) return definitions[0];
    return definitions.find(
      (definition) =>
        threadId === definition.id ||
        threadId.startsWith(`${definition.id}:`) ||
        (hasUniqueProvider(definition.provider) &&
          (threadId === definition.provider ||
            threadId.startsWith(`${definition.provider}:`))) ||
        threadId === definition.adapterName ||
        threadId.startsWith(`${definition.adapterName}:`)
    );
  };
  const shardThread = (threadId: string): string =>
    forThreadId(threadId)?.shardKey?.(threadId) ||
    threadId.split(":").slice(0, 2).join(":") ||
    "default";
  return {
    forThread: (thread: ChatThread) =>
      byAdapterName.get(thread.toJSON().adapterName) ??
      forThreadId(thread.id) ??
      forThreadId(thread.channelId),
    shardThread,
    shardStateKey(key: string): string | undefined {
      for (const definition of definitions) {
        const shard = definition.keyShard?.(key);
        if (shard) return shard;
      }
      return defaultKeyShard(key, shardThread);
    }
  };
}

async function messengerEvent(
  definition: NormalizedMessengerDefinition,
  input: ChatSdkMessengerEventInput
): Promise<MessengerEvent> {
  return (
    (await definition.toEvent?.(input)) ??
    defaultChatSdkEvent(definition, input)
  );
}

export function normalizeMessengers(
  messengers: ThinkMessengers
): NormalizedMessengerDefinition[] {
  const ids = new Set<string>();
  const adapterNames = new Set<string>();
  const paths = new Set<string>();
  const normalized: NormalizedMessengerDefinition[] = [];

  for (const [id, definition] of Object.entries(messengers)) {
    if (ids.has(id)) {
      throw new Error(`Duplicate messenger id: ${id}`);
    }
    ids.add(id);

    const path = definition.path ?? `/messengers/${id}/webhook`;
    validatePath(path, id);
    if (definition.verifyWebhook === undefined) {
      throw new Error(
        `Messenger ${id} requires verifyWebhook, or verifyWebhook: false to opt out explicitly`
      );
    }
    const verifyWebhook = definition.verifyWebhook;
    if (adapterNames.has(definition.adapterName)) {
      throw new Error(
        `Duplicate messenger adapter name: ${definition.adapterName}`
      );
    }
    adapterNames.add(definition.adapterName);
    if (paths.has(path)) {
      throw new Error(`Duplicate messenger path: ${path}`);
    }
    paths.add(path);

    normalized.push({
      ...definition,
      id,
      path,
      respondTo: definition.respondTo ?? ["direct-message", "mention"],
      subscribeOnMention: definition.subscribeOnMention ?? true,
      verifyWebhook
    });
  }

  return normalized;
}

export function defaultConversationName(event: MessengerEvent): string {
  return `messenger:${event.messengerId}:${stableNamePart(event.thread.id)}`;
}

export function idempotencyKeyForEvent(event: MessengerEvent): string {
  return [
    "messenger",
    event.messengerId,
    "message",
    event.thread.id,
    idempotencyEventPart(event)
  ].join(":");
}

function idempotencyEventPart(event: MessengerEvent): string {
  if (event.message) {
    return event.message.id;
  }

  if (event.action) {
    return [
      "action",
      stableNamePart(event.action.messageId ?? "unknown-message"),
      stableNamePart(event.action.actionId),
      stableNamePart(event.action.user?.userId ?? "unknown-user"),
      stableNamePart(event.action.value ?? "no-value")
    ].join(":");
  }

  return event.kind;
}

export function defaultChatSdkEvent(
  definition: NormalizedMessengerDefinition,
  input: ChatSdkMessengerEventInput
): MessengerEvent {
  const convert = (chatMessage: ChatMessage): MessengerMessage => {
    const message = toMessengerMessage(chatMessage);
    message.text = resolveSelfMention(
      message.text,
      definition.adapter.botUserId,
      definition.userName
    );
    return message;
  };
  const skipped = input.skipped?.length
    ? input.skipped.map(convert)
    : undefined;
  return {
    capabilities: definition.capabilities ?? {},
    action: input.action && toMessengerAction(input.action),
    kind: input.eventKind,
    message: input.message && convert(input.message),
    messengerId: definition.id,
    provider: definition.provider,
    raw: input.raw ?? input.message?.raw,
    ...(skipped && { skipped }),
    thread: toMessengerThread(input.thread)
  };
}

/**
 * Rewrite the bot's own unresolved self-mention to `@<userName>`.
 *
 * Adapters resolve every user's `<@id>` mention to a readable `@DisplayName`
 * except the bot's own, which is deliberately left as a raw id token so mention
 * detection can still find it. That raw id is therefore the only unresolved
 * mention that can survive in the text, so once it has served its purpose we
 * replace it with the bot's configured handle before the model sees it —
 * reconstructing the readable `@handle` the sender originally typed. Handles
 * both the angle-bracket form (`<@U123>` / `<@!U123>`, Slack/Discord) and the
 * bare `@U123` form some adapters normalize to. No-op when the adapter does not
 * expose a `botUserId`.
 */
export function resolveSelfMention(
  text: string,
  botUserId: string | undefined,
  userName: string
): string {
  if (!botUserId) {
    return text;
  }
  const id = escapeRegExp(botUserId);
  const replacement = `@${userName}`;
  return text
    .replace(new RegExp(`<@!?${id}>`, "g"), replacement)
    .replace(new RegExp(`@${id}\\b`, "g"), replacement);
}

/**
 * Whether a message mentions the bot. The Chat SDK only runs its own mention
 * detection on the message it dispatches, so messages a burst folded into
 * `skipped` carry `isMention` only when their adapter set it. This mirrors the
 * SDK's check (`@userName`, `@botUserId`, `<@botUserId>`) for them.
 */
export function mentionsBot(
  definition: Pick<NormalizedMessengerDefinition, "adapter" | "userName">,
  message: Pick<ChatMessage, "isMention" | "text">
): boolean {
  if (message.isMention) return true;
  const userName = definition.adapter.userName || definition.userName;
  const patterns = [new RegExp(`@${escapeRegExp(userName)}\\b`, "i")];
  const botUserId = definition.adapter.botUserId;
  if (botUserId) {
    const id = escapeRegExp(botUserId);
    patterns.push(new RegExp(`@${id}\\b`, "i"), new RegExp(`<@!?${id}>`, "i"));
  }
  return patterns.some((pattern) => pattern.test(message.text));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toMessengerAction(action: ChatActionEvent): MessengerAction {
  return {
    actionId: action.actionId,
    messageId: action.messageId,
    raw: action.raw,
    user: toMessengerAuthor(action.user),
    value: action.value
  };
}

export function toMessengerThread(thread: ChatThread): MessengerThread {
  return {
    channelId: thread.channelId,
    channelName: thread.channel.name ?? undefined,
    id: thread.id,
    isDirectMessage: thread.isDM,
    providerThreadId: thread.id
  };
}

export function toMessengerMessage(message: ChatMessage): MessengerMessage {
  return {
    attachments: message.attachments.map(toMessengerAttachment),
    author: toMessengerAuthor(message.author),
    createdAt: message.metadata.dateSent,
    id: message.id,
    isMention: message.isMention,
    providerMessageId: message.id,
    raw: message.raw,
    text: message.text
  };
}

export function toMessengerAuthor(author: ChatAuthor): MessengerAuthor {
  return {
    fullName: author.fullName || undefined,
    isBot: author.isBot,
    isMe: author.isMe,
    userId: author.userId,
    userName: author.userName || undefined
  };
}

export function toMessengerAttachment(
  attachment: ChatAttachment
): MessengerAttachment {
  const fetchMetadata = attachment.fetchMetadata;
  const inline: unknown = attachment.data;
  const data =
    inline instanceof ArrayBuffer || ArrayBuffer.isView(inline)
      ? attachmentBytes(inline)
      : undefined;
  const blob = inline instanceof Blob ? inline : undefined;
  return {
    data,
    fetch: attachment.fetchData
      ? async () => {
          const fetched = await attachment.fetchData?.();
          return fetched ? attachmentBytes(fetched) : new ArrayBuffer(0);
        }
      : data
        ? () => Promise.resolve(data)
        : blob
          ? () => blob.arrayBuffer()
          : undefined,
    fetchMetadata: fetchMetadata ? { ...fetchMetadata } : undefined,
    id: identifierFromFetchMetadata(fetchMetadata),
    mediaType: attachment.mimeType,
    name: attachment.name,
    raw: attachment,
    size: attachment.size,
    url: attachment.url
  };
}

/**
 * `chat` adapters resolve `fetchData` to a `Buffer` or, from `chat@4.41`
 * (inside this package's `^4.31.0` range), a plain `ArrayBuffer`. A `Buffer` is
 * a view that may share a pooled or `SharedArrayBuffer` backing store with
 * unrelated bytes, so only its own range is copied out; a view spanning its
 * whole `ArrayBuffer` hands that buffer over as is.
 */
function attachmentBytes(data: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (data instanceof ArrayBuffer) {
    return data;
  }
  if (
    data.buffer instanceof ArrayBuffer &&
    data.byteOffset === 0 &&
    data.byteLength === data.buffer.byteLength
  ) {
    return data.buffer;
  }
  const copy = new Uint8Array(data.byteLength);
  copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return copy.buffer;
}

const FETCH_METADATA_ID_KEYS = ["id", "fileId", "mediaId", "fileUniqueId"];

/**
 * Best-effort top-level id for an attachment whose adapter only records its
 * identifier in `fetchMetadata` (e.g. Telegram `fileId`). This keeps id-based
 * consumers working without per-adapter knowledge, while the full
 * `fetchMetadata` is preserved verbatim for precise re-fetching.
 */
function identifierFromFetchMetadata(
  fetchMetadata: Record<string, string> | undefined
): string | undefined {
  if (!fetchMetadata) {
    return undefined;
  }
  for (const key of FETCH_METADATA_ID_KEYS) {
    const value = fetchMetadata[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function stableNamePart(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9:_-]/g, "_");
  if (safe.length <= 80) {
    return safe;
  }
  return `${safe.slice(0, 48)}_${hashString(value)}`;
}

function hashString(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function validatePath(path: string, id: string): void {
  if (!path.startsWith("/")) {
    throw new Error(`Messenger ${id} path must start with "/"`);
  }
  if (path.includes("?") || path.includes("#")) {
    throw new Error(`Messenger ${id} path must not include query or hash`);
  }
}
