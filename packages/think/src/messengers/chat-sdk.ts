import type { UIMessage } from "ai";
import type {
  Adapter,
  ActionEvent as ChatActionEvent,
  Attachment as ChatAttachment,
  Author as ChatAuthor,
  ChatConfig,
  Message as ChatMessage,
  Thread as ChatThread
} from "chat";
import { Chat } from "chat";
import type {
  Agent,
  FiberContext,
  FiberRecoveryContext,
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
  MessengerAttachment,
  MessengerAction,
  MessengerAuthor,
  MessengerCapabilities,
  MessengerEvent,
  MessengerEventKind,
  MessengerMessage,
  MessengerThread
} from "./events";
import { serializableMessengerEvent, toMessengerUserMessage } from "./events";
import {
  deliverMessengerReply,
  MESSENGER_REPLY_FIBER_NAME,
  messengerReplyRecoveryMode,
  messengerReplySnapshot,
  parseMessengerReplySnapshot,
  type MessengerDeliveryPolicy,
  type MessengerDeliverySurface,
  type MessengerDeliveryTarget
} from "./delivery";

export class ThinkMessengerStateAgent extends ChatSdkStateAgent {}

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
  subAgent<T extends Agent>(
    agentClass: SubAgentClass<T>,
    name: string
  ): Promise<SubAgentStub<T>>;
}

export interface MessengerFiberStartResult {
  accepted: boolean;
  fiberId: string;
  snapshot?: unknown;
  status: string;
}

export function defineMessengers<T extends ThinkMessengers>(messengers: T): T {
  return messengers;
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
  private readonly definitionsByAdapterName = new Map<
    string,
    NormalizedMessengerDefinition
  >();
  private readonly definitionsById = new Map<
    string,
    NormalizedMessengerDefinition
  >();
  private readonly definitions: NormalizedMessengerDefinition[];

  constructor(
    definitions: ThinkMessengers,
    private readonly host: MessengerThinkHost
  ) {
    this.definitions = normalizeMessengers(definitions);
    for (const definition of this.definitions) {
      this.definitionsByAdapterName.set(definition.adapterName, definition);
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

  async handleFiberRecovery(ctx: FiberRecoveryContext): Promise<boolean> {
    if (ctx.name !== MESSENGER_REPLY_FIBER_NAME) {
      return false;
    }

    const snapshot = parseMessengerReplySnapshot(ctx.snapshot);
    if (!snapshot) {
      return false;
    }

    const definition = this.definitionsById.get(snapshot.event.messengerId);
    if (!definition) {
      throw new Error(
        `No messenger definition found for recovered messenger ${snapshot.event.messengerId}`
      );
    }

    const thread = this.reviveChatObject<ChatThread>(snapshot.thread);
    const mode = messengerReplyRecoveryMode(snapshot);

    if (mode === "answer") {
      await this.answer(
        definition,
        snapshot.event,
        thread,
        undefined,
        snapshot.event,
        async (nextSnapshot) => {
          await this.host.resolveFiber(ctx.id, {
            snapshot: nextSnapshot,
            status:
              nextSnapshot.stage === "completed" ? "completed" : "interrupted"
          });
        }
      );
      return true;
    }

    if (mode === "apologize") {
      await thread.post(
        definition.delivery?.interruptedResponseText ??
          "Sorry, my reply was interrupted. Please send your message again if you'd like me to retry."
      );
      await this.host.resolveFiber(ctx.id, { status: "completed" });
      return true;
    }

    await this.host.resolveFiber(ctx.id, { status: "completed" });
    return true;
  }

  private createChat(): Chat<Record<string, Adapter>> {
    const adapters = Object.fromEntries(
      this.definitions.map((definition) => [
        definition.adapterName,
        definition.adapter
      ])
    ) as Record<string, Adapter>;
    const chat = new Chat({
      adapters,
      concurrency: { debounceMs: 600, strategy: "burst" },
      state: createChatSdkState({
        agent: ThinkMessengerStateAgent,
        keyShard: (key) => this.shardStateKey(key),
        parent: this.host as unknown as ChatSdkStateAdapterOptions["parent"],
        shardKey: (threadId) => this.shardThread(threadId)
      }),
      userName: this.definitions[0]?.userName ?? "think"
    } satisfies ChatConfig<Record<string, Adapter>>);

    chat.onDirectMessage(async (thread, message) => {
      const definition = this.definitionForThread(thread);
      if (!definition) return;
      if (definition.respondTo.includes("direct-message")) {
        await this.enqueueReply(
          definition,
          await this.toEvent(definition, {
            eventKind: "direct-message",
            message,
            thread
          }),
          thread
        );
      }
    });

    chat.onNewMention(async (thread, message) => {
      const definition = this.definitionForThread(thread);
      if (!definition) return;
      if (definition.subscribeOnMention) {
        await thread.subscribe();
      }
      if (definition.respondTo.includes("mention")) {
        await this.enqueueReply(
          definition,
          await this.toEvent(definition, {
            eventKind: "mention",
            message,
            thread
          }),
          thread
        );
      }
    });

    chat.onSubscribedMessage(async (thread, message) => {
      const definition = this.definitionForThread(thread);
      if (!definition) return;
      if (
        definition.respondTo.includes("subscribed-thread") ||
        (message.isMention && definition.respondTo.includes("mention"))
      ) {
        await this.enqueueReply(
          definition,
          await this.toEvent(definition, {
            eventKind: message.isMention ? "mention" : "subscribed-message",
            message,
            thread
          }),
          thread
        );
      }
    });

    chat.onAction(async (event) => {
      if (!event.thread) return;
      const thread = event.thread as ChatThread;
      const definition = this.definitionForThread(thread);
      if (!definition) return;
      if (definition.respondTo.includes("action")) {
        await this.enqueueReply(
          definition,
          await this.toEvent(definition, {
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

  private async enqueueReply(
    definition: NormalizedMessengerDefinition,
    event: MessengerEvent,
    thread: ChatThread
  ): Promise<void> {
    const snapshotEvent = serializableMessengerEvent(event);
    const snapshotThread = thread.toJSON();
    const result = await this.host.startFiber(
      MESSENGER_REPLY_FIBER_NAME,
      async (fiber) => {
        fiber.stash(
          messengerReplySnapshot("accepted", snapshotEvent, snapshotThread)
        );
        await this.answer(definition, event, thread, fiber, snapshotEvent);
      },
      {
        idempotencyKey: idempotencyKeyForEvent(event),
        metadata: {
          messengerId: event.messengerId,
          messageId: event.message?.id,
          provider: event.provider,
          threadId: event.thread.id
        },
        waitForCompletion: true
      }
    );

    if (result.accepted || result.status !== "interrupted") {
      return;
    }

    const snapshot = parseMessengerReplySnapshot(result.snapshot);
    if (!snapshot) {
      return;
    }

    const mode = messengerReplyRecoveryMode(snapshot);
    if (mode === "answer") {
      await this.answer(
        definition,
        snapshot.event,
        thread,
        undefined,
        snapshot.event,
        async (nextSnapshot) => {
          await this.host.resolveFiber(result.fiberId, {
            snapshot: nextSnapshot,
            status:
              nextSnapshot.stage === "completed" ? "completed" : "interrupted"
          });
        }
      );
      return;
    }

    if (mode === "apologize") {
      await thread
        .post(
          definition.delivery?.interruptedResponseText ??
            "Sorry, my reply was interrupted. Please send your message again if you'd like me to retry."
        )
        .catch(() => undefined);
      await this.host.resolveFiber(result.fiberId, { status: "completed" });
    }
  }

  private async answer(
    definition: NormalizedMessengerDefinition,
    event: MessengerEvent,
    thread: ChatThread,
    fiber?: FiberContext,
    snapshotEvent = serializableMessengerEvent(event),
    checkpoint?: (
      snapshot: ReturnType<typeof messengerReplySnapshot>
    ) => Promise<void> | void
  ): Promise<void> {
    const target = await this.resolveTarget(definition, event);
    await deliverMessengerReply({
      event,
      checkpoint,
      fiber,
      policy: definition.delivery,
      snapshotEvent,
      snapshotThread: thread.toJSON(),
      surface: thread satisfies MessengerDeliverySurface,
      target,
      userMessage: toMessengerUserMessage(event)
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
    return (await this.host.subAgent(
      agentClass,
      target.name
    )) as unknown as MessengerDeliveryTarget;
  }

  private definitionForThread(
    thread: ChatThread
  ): NormalizedMessengerDefinition | undefined {
    return (
      this.definitionsByAdapterName.get(thread.toJSON().adapterName) ??
      this.definitionForThreadId(thread.id) ??
      this.definitionForThreadId(thread.channelId)
    );
  }

  private definitionForThreadId(
    threadId: string | undefined
  ): NormalizedMessengerDefinition | undefined {
    if (!threadId) {
      return undefined;
    }

    if (this.definitions.length === 1) {
      return this.definitions[0];
    }

    return this.definitions.find(
      (definition) =>
        threadId === definition.id ||
        threadId.startsWith(`${definition.id}:`) ||
        (this.hasUniqueProvider(definition.provider) &&
          (threadId === definition.provider ||
            threadId.startsWith(`${definition.provider}:`))) ||
        threadId === definition.adapterName ||
        threadId.startsWith(`${definition.adapterName}:`)
    );
  }

  private hasUniqueProvider(provider: string): boolean {
    return (
      this.definitions.filter((definition) => definition.provider === provider)
        .length === 1
    );
  }

  private shardThread(threadId: string): string {
    const definition = this.definitionForThreadId(threadId);
    return (
      definition?.shardKey?.(threadId) ||
      threadId.split(":").slice(0, 2).join(":") ||
      "default"
    );
  }

  private shardStateKey(key: string): string | undefined {
    for (const definition of this.definitions) {
      const shard = definition.keyShard?.(key);
      if (shard) {
        return shard;
      }
    }

    return defaultKeyShard(key, (threadId) => this.shardThread(threadId));
  }

  private reviveChatObject<T>(value: unknown): T {
    if (value === undefined) {
      throw new Error(
        "Messenger recovery snapshot is missing chat object data"
      );
    }
    const chat = this.chat ?? this.createChat();
    this.chat = chat;
    return JSON.parse(JSON.stringify(value), chat.reviver()) as T;
  }

  private async toEvent(
    definition: NormalizedMessengerDefinition,
    input: ChatSdkMessengerEventInput
  ): Promise<MessengerEvent> {
    return (
      (await definition.toEvent?.(input)) ??
      defaultChatSdkEvent(definition, input)
    );
  }
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
  return {
    capabilities: definition.capabilities ?? {},
    action: input.action && toMessengerAction(input.action),
    kind: input.eventKind,
    message: input.message && toMessengerMessage(input.message),
    messengerId: definition.id,
    provider: definition.provider,
    raw: input.raw ?? input.message?.raw,
    thread: toMessengerThread(input.thread)
  };
}

export function toMessengerAction(action: ChatActionEvent): MessengerAction {
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
  return {
    fetch: attachment.fetchData
      ? async () => {
          const data = await attachment.fetchData?.();
          if (!data) {
            return new ArrayBuffer(0);
          }
          const copy = data.buffer.slice(
            data.byteOffset,
            data.byteOffset + data.byteLength
          );
          return copy instanceof ArrayBuffer ? copy : new ArrayBuffer(0);
        }
      : undefined,
    mediaType: attachment.mimeType,
    name: attachment.name,
    raw: attachment,
    size: attachment.size,
    url: attachment.url
  };
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
