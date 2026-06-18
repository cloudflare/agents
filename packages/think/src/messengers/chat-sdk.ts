import type { UIMessage } from "ai";
import type {
  Adapter,
  ActionEvent as ChatActionEvent,
  Attachment as ChatAttachment,
  Author as ChatAuthor,
  Channel as ChatChannel,
  ChatConfig,
  Message as ChatMessage,
  ReactionEvent as ChatReactionEvent,
  SlashCommandEvent as ChatSlashCommandEvent,
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
  MessengerCommand,
  MessengerEvent,
  MessengerEventKind,
  MessengerMessage,
  MessengerReaction,
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

interface ChatThreadReference {
  channel: { name: string | null };
  channelId: string;
  id: string;
  isDM: boolean;
  toJSON(): unknown;
}

interface ChatChannelReference {
  id: string;
  isDM: boolean;
  name: string | null;
  toJSON(): unknown;
}

export type MessengerRespondTo =
  | "action"
  | "command"
  | "direct-message"
  | "mention"
  | "reaction"
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

export interface MessengerBackgroundContext {
  chat: Chat<Record<string, Adapter>>;
  definition: NormalizedMessengerDefinition;
  host: MessengerThinkHost;
  messengerId: string;
}

export interface MessengerBackgroundIngress {
  /**
   * Start provider-owned ingress after Chat SDK state and adapters are ready.
   * The runtime retries startup failures, but a successful start means the
   * provider has taken durable ownership of reconnects/retries from there.
   */
  start(context: MessengerBackgroundContext): Promise<void> | void;
}

export interface MessengerDefinition {
  adapter: Adapter;
  adapterName: string;
  background?: MessengerBackgroundIngress;
  capabilities?: MessengerCapabilities;
  conversation?: MessengerConversationMode | MessengerConversationResolver;
  delivery?: MessengerDeliveryPolicy;
  keyShard?: ChatSdkStateAdapterOptions["keyShard"];
  path?: string | false;
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
  path: string | false;
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
  channel?: ChatChannel;
  command?: ChatSlashCommandEvent;
  eventKind: MessengerEventKind;
  message?: ChatMessage;
  raw?: unknown;
  reaction?: ChatReactionEvent;
  thread?: ChatThread;
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
  private readonly backgroundStartTasks = new Map<string, Promise<void>>();
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

    void this.startBackgroundIngress(this.getOrCreateChat());
  }

  async handleRequest(request: Request): Promise<Response | undefined> {
    if (this.host.parentPath.length > 0) {
      return undefined;
    }

    const url = new URL(request.url);
    const definition = this.definitions.find(
      (candidate) => candidate.path !== false && candidate.path === url.pathname
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

    const chat = this.getOrCreateChat();
    void this.startBackgroundIngress(chat);
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

    const surface = this.reviveChatObject<MessengerDeliverySurface>(
      snapshot.thread
    );
    const mode = messengerReplyRecoveryMode(snapshot);

    if (mode === "answer") {
      await this.answer(
        definition,
        snapshot.event,
        surface,
        snapshot.thread,
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
      await surface.post(
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
      const definition = this.definitionForChatObject(thread);
      if (!definition) return;
      if (definition.respondTo.includes("direct-message")) {
        await this.enqueueReply(
          definition,
          await this.toEvent(definition, {
            eventKind: "direct-message",
            message,
            thread
          }),
          thread,
          thread.toJSON()
        );
      }
    });

    chat.onNewMention(async (thread, message) => {
      const definition = this.definitionForChatObject(thread);
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
          thread,
          thread.toJSON()
        );
      }
    });

    chat.onSubscribedMessage(async (thread, message) => {
      const definition = this.definitionForChatObject(thread);
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
          thread,
          thread.toJSON()
        );
      }
    });

    chat.onAction(async (event) => {
      if (!event.thread) return;
      const thread = event.thread as ChatThread;
      const definition = this.definitionForChatObject(thread);
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
          thread,
          thread.toJSON()
        );
      }
    });

    chat.onSlashCommand(async (event) => {
      const definition = this.definitionForChatObject(event.channel);
      if (!definition) return;
      if (definition.respondTo.includes("command")) {
        const channel = event.channel as MessengerDeliverySurface;
        await this.enqueueReply(
          definition,
          await this.toEvent(definition, {
            channel: event.channel,
            command: event,
            eventKind: "command",
            raw: event.raw
          }),
          channel,
          event.channel.toJSON()
        );
      }
    });

    chat.onReaction(async (event) => {
      if (!event.thread) return;
      const thread = event.thread as ChatThread;
      const definition = this.definitionForChatObject(thread);
      if (!definition) return;
      if (definition.respondTo.includes("reaction")) {
        await this.enqueueReply(
          definition,
          await this.toEvent(definition, {
            eventKind: "reaction",
            raw: event.raw,
            reaction: event,
            thread
          }),
          thread,
          thread.toJSON()
        );
      }
    });

    return chat.registerSingleton();
  }

  private async enqueueReply(
    definition: NormalizedMessengerDefinition,
    event: MessengerEvent,
    surface: MessengerDeliverySurface,
    snapshotSurface: unknown
  ): Promise<void> {
    const snapshotEvent = serializableMessengerEvent(event);
    const result = await this.host.startFiber(
      MESSENGER_REPLY_FIBER_NAME,
      async (fiber) => {
        fiber.stash(
          messengerReplySnapshot("accepted", snapshotEvent, snapshotSurface)
        );
        await this.answer(
          definition,
          event,
          surface,
          snapshotSurface,
          fiber,
          snapshotEvent
        );
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
        surface,
        snapshotSurface,
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
      await surface
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
    surface: MessengerDeliverySurface,
    snapshotSurface: unknown,
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
      snapshotThread: snapshotSurface,
      surface,
      target,
      userMessage: toMessengerUserMessage(event)
    });
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

  private definitionForChatObject(
    chatObject: ChatThreadReference | ChatChannelReference
  ): NormalizedMessengerDefinition | undefined {
    const serialized = chatObject.toJSON() as { adapterName?: unknown };
    const adapterName =
      typeof serialized.adapterName === "string"
        ? serialized.adapterName
        : undefined;
    return (
      (adapterName
        ? this.definitionsByAdapterName.get(adapterName)
        : undefined) ??
      this.definitionForThreadId(chatObject.id) ??
      this.definitionForThreadId(
        "channelId" in chatObject ? chatObject.channelId : undefined
      )
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
    const chat = this.getOrCreateChat();
    void this.startBackgroundIngress(chat);
    return JSON.parse(JSON.stringify(value), chat.reviver()) as T;
  }

  private getOrCreateChat(): Chat<Record<string, Adapter>> {
    const chat = this.chat ?? this.createChat();
    this.chat = chat;
    return chat;
  }

  private async startBackgroundIngress(
    chat: Chat<Record<string, Adapter>>
  ): Promise<void> {
    if (this.host.parentPath.length > 0) return;
    for (const definition of this.definitions) {
      if (!definition.background) {
        continue;
      }

      void this.startBackgroundDefinition(chat, definition);
    }
  }

  private startBackgroundDefinition(
    chat: Chat<Record<string, Adapter>>,
    definition: NormalizedMessengerDefinition
  ): Promise<void> {
    const existing = this.backgroundStartTasks.get(definition.id);
    if (existing) {
      return existing;
    }

    const task = (async () => {
      try {
        await chat.initialize();
        await definition.background?.start({
          chat,
          definition,
          host: this.host,
          messengerId: definition.id
        });
      } catch (error) {
        this.backgroundStartTasks.delete(definition.id);
        console.error(
          `Messenger ${definition.id} background ingress failed`,
          error
        );
      }
    })();

    this.backgroundStartTasks.set(definition.id, task);
    return task;
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
    if (path === false && !definition.background) {
      throw new Error(
        `Messenger ${id} with path: false requires background ingress`
      );
    }
    if (path !== false) {
      validatePath(path, id);
    }
    if (path !== false && definition.verifyWebhook === undefined) {
      throw new Error(
        `Messenger ${id} requires verifyWebhook, or verifyWebhook: false to opt out explicitly`
      );
    }
    const verifyWebhook = path === false ? false : definition.verifyWebhook!;
    if (adapterNames.has(definition.adapterName)) {
      throw new Error(
        `Duplicate messenger adapter name: ${definition.adapterName}`
      );
    }
    adapterNames.add(definition.adapterName);
    if (path !== false && paths.has(path)) {
      throw new Error(`Duplicate messenger path: ${path}`);
    }
    if (path !== false) {
      paths.add(path);
    }

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

  if (event.command) {
    return [
      "command",
      stableNamePart(
        event.command.providerCommandId ??
          providerRawId(event.command.raw) ??
          event.command.command
      ),
      stableNamePart(event.command.command),
      stableNamePart(event.command.user?.userId ?? "unknown-user"),
      stableNamePart(event.command.text ?? "no-text")
    ].join(":");
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

  if (event.reaction) {
    return [
      "reaction",
      stableNamePart(event.reaction.messageId),
      stableNamePart(event.reaction.emoji),
      stableNamePart(event.reaction.user?.userId ?? "unknown-user"),
      event.reaction.added ? "added" : "removed"
    ].join(":");
  }

  return event.kind;
}

export function defaultChatSdkEvent(
  definition: NormalizedMessengerDefinition,
  input: ChatSdkMessengerEventInput
): MessengerEvent {
  const thread = input.thread
    ? toMessengerThread(input.thread)
    : input.channel
      ? toMessengerThreadFromChannel(input.channel)
      : input.command
        ? toMessengerThreadFromChannel(input.command.channel)
        : input.reaction
          ? toMessengerThread(input.reaction.thread)
          : undefined;
  if (!thread) {
    throw new Error(`Messenger event ${input.eventKind} is missing a surface`);
  }

  return {
    capabilities: definition.capabilities ?? {},
    action: input.action && toMessengerAction(input.action),
    command: input.command && toMessengerCommand(input.command),
    kind: input.eventKind,
    message: input.message && toMessengerMessage(input.message),
    messengerId: definition.id,
    provider: definition.provider,
    raw:
      input.raw ??
      input.message?.raw ??
      input.action?.raw ??
      input.command?.raw ??
      input.reaction?.raw,
    reaction: input.reaction && toMessengerReaction(input.reaction),
    thread
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

export function toMessengerCommand(
  command: ChatSlashCommandEvent
): MessengerCommand {
  return {
    command: command.command,
    providerCommandId: providerRawId(command.raw),
    raw: command.raw,
    text: command.text || undefined,
    user: toMessengerAuthor(command.user)
  };
}

export function toMessengerReaction(
  reaction: ChatReactionEvent
): MessengerReaction {
  return {
    added: reaction.added,
    emoji: reaction.emoji.name || reaction.rawEmoji,
    messageId: reaction.messageId,
    raw: reaction.raw,
    user: toMessengerAuthor(reaction.user)
  };
}

export function toMessengerThread(
  thread: ChatThreadReference
): MessengerThread {
  return {
    channelId: thread.channelId,
    channelName: thread.channel.name ?? undefined,
    id: thread.id,
    isDirectMessage: thread.isDM,
    providerThreadId: thread.id
  };
}

export function toMessengerThreadFromChannel(
  channel: ChatChannelReference
): MessengerThread {
  return {
    channelId: channel.id,
    channelName: channel.name ?? undefined,
    id: channel.id,
    isDirectMessage: channel.isDM,
    providerThreadId: channel.id
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

function providerRawId(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== "object") {
    return undefined;
  }

  const candidate = raw as { id?: unknown };
  return typeof candidate.id === "string" ? candidate.id : undefined;
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
