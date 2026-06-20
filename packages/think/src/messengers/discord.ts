import type {
  Adapter,
  AdapterPostableMessage,
  ChannelInfo,
  ChatInstance,
  EmojiValue,
  FetchOptions,
  FetchResult,
  FormattedContent,
  RawMessage,
  StreamChunk,
  ThreadInfo,
  WebhookOptions
} from "chat";
import { stringifyMarkdown } from "chat";
import type {
  ChatSdkMessengerEventInput,
  ChatSdkMessengerOptions,
  MessengerDefinition,
  NormalizedMessengerDefinition
} from "./chat-sdk";
import { chatSdkMessenger, defaultChatSdkEvent } from "./chat-sdk";

export const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
export const DISCORD_STREAM_SOFT_LIMIT = 1_800;
export const DISCORD_FOLLOWUP_CHUNK_LIMIT = 1_900;
export const DISCORD_INTERACTION_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1_000;
export const DISCORD_INTERACTION_TOKEN_TTL_MS = 15 * 60 * 1_000;
export const DISCORD_INTERACTION_BODY_LIMIT_BYTES = 64 * 1_024;

const DISCORD_PUBLIC_KEY_PATTERN = /^[a-fA-F0-9]{64}$/;
const DISCORD_SIGNATURE_PATTERN = /^[a-fA-F0-9]{128}$/;

export interface DiscordMessengerOptions extends Omit<
  ChatSdkMessengerOptions,
  "adapter" | "provider" | "userName" | "verifyWebhook"
> {
  apiUrl?: string;
  applicationId: string;
  fetch?: typeof fetch;
  interactions?: boolean | DiscordInteractionsOptions;
  publicKey?: string;
  token?: string;
  userName: string;
}

export interface DiscordInteractionsOptions {
  enabled?: boolean;
  timestampToleranceMs?: number;
}

interface DiscordAdapterConfig {
  adapterName: string;
  apiUrl?: string;
  applicationId: string;
  fetch?: typeof fetch;
  publicKey?: string;
  timestampToleranceMs?: number;
  userName?: string;
}

interface DiscordMessagePayload {
  allowed_mentions?: DiscordAllowedMentions;
  content?: string;
}

interface DiscordAllowedMentions {
  parse?: ("everyone" | "roles" | "users")[];
  replied_user?: boolean;
  roles?: string[];
  users?: string[];
}

interface DiscordInteractionResponseContext {
  channelId: string;
  expiresAt: number;
  initialResponseSent: boolean;
  token: string;
}

export interface DiscordThreadId {
  channelId: string;
  guildId: string;
  threadId?: string;
}

export interface DiscordInteraction {
  application_id: string;
  channel?: DiscordInteractionChannel;
  channel_id?: string;
  data?: DiscordInteractionData;
  guild_id?: string;
  id: string;
  member?: { user?: DiscordUser };
  message?: { id?: string };
  token: string;
  type: number;
  user?: DiscordUser;
  version: number;
}

export interface DiscordInteractionChannel {
  id: string;
  name?: string;
  parent_id?: string;
  type: number;
}

export interface DiscordInteractionData {
  custom_id?: string;
  name?: string;
  options?: DiscordCommandOption[];
  values?: string[];
}

export interface DiscordCommandOption {
  name: string;
  options?: DiscordCommandOption[];
  value?: boolean | number | string;
}

export interface DiscordUser {
  bot?: boolean;
  global_name?: string | null;
  id: string;
  username: string;
}

export interface DiscordCustomId {
  actionId: string;
  value?: string;
}

const DISCORD_INTERACTION_TYPE = {
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  PING: 1
} as const;

const DISCORD_RESPONSE_TYPE = {
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  PONG: 1
} as const;

const DISCORD_THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);
const DISCORD_CUSTOM_ID_MAX_LENGTH = 100;
const DISCORD_CUSTOM_ID_SEPARATOR = "\n";
const DISCORD_CONTENT_MAX_LENGTH = 2_000;

class DiscordAdapter implements Adapter<DiscordThreadId, unknown> {
  readonly name: string;
  readonly botUserId: string;
  readonly userName: string;
  protected chat?: ChatInstance;
  protected readonly apiUrl: string;
  protected readonly applicationId: string;
  protected readonly fetcher: typeof fetch;
  protected readonly publicKey: string;
  protected readonly timestampToleranceMs: number;

  constructor(config: DiscordAdapterConfig) {
    this.apiUrl = config.apiUrl ?? DISCORD_API_BASE_URL;
    this.applicationId = config.applicationId;
    this.botUserId = config.applicationId;
    this.fetcher = config.fetch ?? fetch;
    this.name = config.adapterName;
    this.publicKey = config.publicKey
      ? normalizeDiscordPublicKey(config.publicKey)
      : "";
    this.timestampToleranceMs = normalizeDiscordTimestampTolerance(
      config.timestampToleranceMs
    );
    this.userName = config.userName ?? "discord";
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
  }

  async handleWebhook(
    request: Request,
    options?: WebhookOptions
  ): Promise<Response> {
    if (!this.publicKey) {
      return new Response("Discord public key is not configured", {
        status: 500
      });
    }
    const bodyResult = await readDiscordInteractionBody(request);
    if (bodyResult instanceof Response) {
      return bodyResult;
    }
    const body = bodyResult;
    const signature = request.headers.get("x-signature-ed25519");
    const timestamp = request.headers.get("x-signature-timestamp");
    const verified = await verifyDiscordInteractionRequest({
      body,
      publicKey: this.publicKey,
      signature,
      timestamp,
      timestampToleranceMs: this.timestampToleranceMs
    });
    if (!verified) {
      return new Response("Invalid signature", { status: 401 });
    }

    let interaction: DiscordInteraction;
    try {
      interaction = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    if (interaction.application_id !== this.applicationId) {
      return new Response("Application mismatch", { status: 401 });
    }

    if (interaction.type === DISCORD_INTERACTION_TYPE.PING) {
      return Response.json({ type: DISCORD_RESPONSE_TYPE.PONG });
    }

    if (interaction.type === DISCORD_INTERACTION_TYPE.APPLICATION_COMMAND) {
      if (!(await this.handleApplicationCommand(interaction, options))) {
        return new Response("Invalid application command", { status: 400 });
      }
      return Response.json({
        type: DISCORD_RESPONSE_TYPE.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
      });
    }

    if (interaction.type === DISCORD_INTERACTION_TYPE.MESSAGE_COMPONENT) {
      if (!(await this.handleMessageComponent(interaction, options))) {
        return Response.json({
          type: DISCORD_RESPONSE_TYPE.DEFERRED_UPDATE_MESSAGE
        });
      }
      return Response.json({
        type: DISCORD_RESPONSE_TYPE.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
      });
    }

    return new Response("Unsupported Discord interaction type", {
      status: 501
    });
  }

  addReaction(
    _threadId: string,
    _messageId: string,
    _emoji: EmojiValue | string
  ): Promise<void> {
    throw new Error("Discord addReaction is not implemented yet");
  }

  channelIdFromThreadId(threadId: string): string {
    return threadId.split(":").slice(0, 3).join(":");
  }

  decodeThreadId(threadId: string): DiscordThreadId {
    const [provider, guildId, channelId, discordThreadId] = threadId.split(":");
    if (provider !== "discord" || !guildId || !channelId) {
      throw new Error(`Invalid Discord thread id: ${threadId}`);
    }
    return { channelId, guildId, threadId: discordThreadId };
  }

  deleteMessage(_threadId: string, _messageId: string): Promise<void> {
    throw new Error("Discord deleteMessage is not implemented yet");
  }

  editMessage(
    _threadId: string,
    _messageId: string,
    _message: AdapterPostableMessage
  ): Promise<RawMessage<unknown>> {
    throw new Error("Discord editMessage is not implemented yet");
  }

  encodeThreadId(platformData: DiscordThreadId): string {
    return [
      "discord",
      platformData.guildId,
      platformData.channelId,
      platformData.threadId
    ]
      .filter(Boolean)
      .join(":");
  }

  fetchChannelInfo(_channelId: string): Promise<ChannelInfo> {
    throw new Error("Discord fetchChannelInfo is not implemented yet");
  }

  fetchMessages(
    _threadId: string,
    _options?: FetchOptions
  ): Promise<FetchResult<unknown>> {
    throw new Error("Discord fetchMessages is not implemented yet");
  }

  fetchThread(_threadId: string): Promise<ThreadInfo> {
    throw new Error("Discord fetchThread is not implemented yet");
  }

  isDM(threadId: string): boolean {
    return this.decodeThreadId(threadId).guildId === "@me";
  }

  parseMessage(_raw: unknown): never {
    throw new Error("Discord parseMessage is not implemented yet");
  }

  postMessage(
    threadId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage<unknown>> {
    return this.postInteractionResponse(threadId, message);
  }

  removeReaction(
    _threadId: string,
    _messageId: string,
    _emoji: EmojiValue | string
  ): Promise<void> {
    throw new Error("Discord removeReaction is not implemented yet");
  }

  renderFormatted(content: FormattedContent): string {
    return stringifyMarkdown(content);
  }

  startTyping(_threadId: string, _status?: string): Promise<void> {
    return Promise.resolve();
  }

  async stream(
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>
  ): Promise<RawMessage<unknown> | null> {
    let text = "";
    for await (const chunk of textStream) {
      if (typeof chunk === "string") {
        text += chunk;
      } else if (chunk.type === "markdown_text") {
        text += chunk.text;
      }
    }
    return this.postMessage(threadId, { markdown: text });
  }

  protected async handleApplicationCommand(
    interaction: DiscordInteraction,
    options?: WebhookOptions
  ): Promise<boolean> {
    if (!this.chat) return false;
    const commandName = interaction.data?.name;
    const user = interaction.member?.user ?? interaction.user;
    const channelId = this.threadIdForInteraction(interaction);
    if (!commandName || !user || !channelId) return false;

    const { command, text } = parseDiscordSlashCommand(
      commandName,
      interaction.data?.options
    );
    const surfaceId = interactionSurfaceId(interaction.id);
    const chat = this.chat;
    this.runInteractionTask(options, async () => {
      await this.storeInteractionResponseContext(surfaceId, {
        channelId,
        expiresAt: Date.now() + DISCORD_INTERACTION_TOKEN_TTL_MS,
        initialResponseSent: false,
        token: interaction.token
      });

      chat.processSlashCommand(
        {
          adapter: this,
          channelId: surfaceId,
          command,
          raw: redactDiscordInteraction(interaction),
          text,
          user: toDiscordAuthor(user)
        },
        options
      );
    });
    return true;
  }

  protected async handleMessageComponent(
    interaction: DiscordInteraction,
    options?: WebhookOptions
  ): Promise<boolean> {
    if (!this.chat) return false;
    const customId = interaction.data?.custom_id;
    const user = interaction.member?.user ?? interaction.user;
    const messageId = interaction.message?.id;
    const threadId = this.threadIdForInteraction(interaction);
    if (!customId || !user || !messageId || !threadId) return false;

    let decoded: DiscordCustomId;
    try {
      decoded = decodeDiscordCustomId(customId);
    } catch {
      return false;
    }
    const selectedValue = selectedDiscordComponentValue(interaction.data);
    const surfaceId = interactionSurfaceId(interaction.id);
    const chat = this.chat;
    this.runInteractionTask(options, async () => {
      await this.storeInteractionResponseContext(surfaceId, {
        channelId: threadId,
        expiresAt: Date.now() + DISCORD_INTERACTION_TOKEN_TTL_MS,
        initialResponseSent: false,
        token: interaction.token
      });
      chat.processAction(
        {
          actionId: decoded.actionId,
          adapter: this,
          messageId,
          raw: redactDiscordInteraction(interaction),
          threadId: surfaceId,
          user: toDiscordAuthor(user),
          value: selectedValue ?? decoded.value
        },
        options
      );
    });
    return true;
  }

  protected runInteractionTask(
    options: WebhookOptions | undefined,
    work: () => Promise<void>
  ): void {
    const task = work().catch((error) => {
      console.error("Discord interaction processing failed", error);
    });
    options?.waitUntil?.(task);
  }

  protected threadIdForInteraction(
    interaction: DiscordInteraction
  ): string | undefined {
    const interactionChannelId =
      interaction.channel_id ?? interaction.channel?.id;
    if (!interactionChannelId) return undefined;
    const guildId = interaction.guild_id ?? "@me";
    const channel = interaction.channel;
    const isThread = channel
      ? DISCORD_THREAD_CHANNEL_TYPES.has(channel.type)
      : false;
    const parentChannelId =
      isThread && channel?.parent_id ? channel.parent_id : interactionChannelId;
    return this.encodeThreadId({
      channelId: parentChannelId,
      guildId,
      threadId: isThread ? interactionChannelId : undefined
    });
  }

  protected async postInteractionResponse(
    surfaceId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage<unknown>> {
    const context = await this.getInteractionResponseContext(surfaceId);
    if (!context) {
      throw new Error(
        "Discord channel message delivery is not implemented yet"
      );
    }

    const payload = this.toDiscordMessagePayload(message);
    const initial = !context.initialResponseSent;
    const applicationId = encodeURIComponent(this.applicationId);
    const token = encodeURIComponent(context.token);
    const path = initial
      ? `/webhooks/${applicationId}/${token}/messages/@original`
      : `/webhooks/${applicationId}/${token}?wait=true`;
    const response = await this.discordInteractionFetch(
      path,
      initial ? "PATCH" : "POST",
      payload
    );
    if (initial) {
      await this.storeInteractionResponseContext(surfaceId, {
        ...context,
        initialResponseSent: true
      });
    }
    const raw = (await response.json()) as { id?: unknown };
    return {
      id: typeof raw.id === "string" ? raw.id : surfaceId,
      raw,
      threadId: context.channelId
    };
  }

  protected async getInteractionResponseContext(
    surfaceId: string
  ): Promise<DiscordInteractionResponseContext | null> {
    const state = this.chat?.getState();
    if (!state) return null;
    const context = await state.get<DiscordInteractionResponseContext>(
      interactionResponseContextKey(surfaceId)
    );
    if (!context) return null;
    if (Date.now() >= context.expiresAt) {
      await state.delete(interactionResponseContextKey(surfaceId));
      return null;
    }
    return context;
  }

  protected async storeInteractionResponseContext(
    surfaceId: string,
    context: DiscordInteractionResponseContext
  ): Promise<void> {
    const state = this.chat?.getState();
    if (!state) return;
    const ttlMs = Math.max(1, context.expiresAt - Date.now());
    await state.set(interactionResponseContextKey(surfaceId), context, ttlMs);
  }

  protected toDiscordMessagePayload(
    message: AdapterPostableMessage
  ): DiscordMessagePayload {
    const rendered = this.renderPostable(message);
    return {
      allowed_mentions: { parse: [] },
      content:
        rendered.length <= DISCORD_CONTENT_MAX_LENGTH
          ? rendered
          : `${rendered.slice(0, DISCORD_CONTENT_MAX_LENGTH - 3)}...`
    };
  }

  protected renderPostable(message: AdapterPostableMessage): string {
    if (typeof message === "string") {
      return message;
    }
    if ("raw" in message && typeof message.raw === "string") {
      return message.raw;
    }
    if ("markdown" in message && typeof message.markdown === "string") {
      return message.markdown;
    }
    if ("ast" in message) {
      return this.renderFormatted(message.ast);
    }
    return "";
  }

  protected async discordInteractionFetch(
    path: string,
    method: string,
    body: unknown
  ): Promise<Response> {
    const response = await this.fetcher(`${this.apiUrl}${path}`, {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method
    });
    if (!response.ok) {
      throw new Error(`Discord interaction request failed: ${response.status}`);
    }
    return response;
  }
}

export function discordMessenger(
  options: DiscordMessengerOptions
): MessengerDefinition {
  const interactions = resolveDiscordInteractionsOptions(options.interactions);
  if (interactions.enabled && !options.publicKey) {
    throw new Error("discordMessenger requires publicKey for Interactions");
  }
  if (!interactions.enabled && !options.background) {
    throw new Error(
      "discordMessenger with interactions disabled requires background ingress"
    );
  }
  const {
    apiUrl: _apiUrl,
    applicationId: _applicationId,
    fetch: _fetch,
    interactions: _interactions,
    publicKey: _publicKey,
    token: _token,
    ...messengerOptions
  } = options;
  const adapterName = options.adapterName ?? "discord";
  const adapter = new DiscordAdapter({
    adapterName,
    apiUrl: options.apiUrl,
    applicationId: options.applicationId,
    fetch: options.fetch,
    publicKey: options.publicKey,
    timestampToleranceMs: interactions.timestampToleranceMs,
    userName: options.userName
  });

  return chatSdkMessenger({
    ...messengerOptions,
    adapter,
    adapterName,
    capabilities: {
      canEditMessages: false,
      canStream: false,
      maxMessageLength: 2_000,
      supportsActions: false,
      supportsAttachments: false,
      supportsEphemeral: false,
      ...options.capabilities
    },
    delivery: {
      splitText: splitDiscordMessageText,
      visibleSoftLimit: DISCORD_STREAM_SOFT_LIMIT,
      ...options.delivery
    },
    path: interactions.enabled ? options.path : false,
    provider: "discord",
    respondTo:
      options.respondTo ??
      (interactions.enabled ? ["command", "action"] : undefined),
    toEvent: options.toEvent ?? discordMessengerEvent,
    userName: options.userName,
    // Discord Interactions verification needs the raw request body, so the
    // adapter handles it internally instead of the generic runtime preflight.
    verifyWebhook: false
  });
}

export default discordMessenger;

export function encodeDiscordCustomId(
  actionId: string,
  value?: string
): string {
  if (!actionId || actionId.includes(DISCORD_CUSTOM_ID_SEPARATOR)) {
    throw new Error("Discord custom_id action id is invalid");
  }
  const customId =
    value !== undefined
      ? `${actionId}${DISCORD_CUSTOM_ID_SEPARATOR}${value}`
      : actionId;
  validateDiscordCustomId(customId);
  return customId;
}

export function decodeDiscordCustomId(customId: string): DiscordCustomId {
  validateDiscordCustomId(customId);
  const separator = customId.indexOf(DISCORD_CUSTOM_ID_SEPARATOR);
  if (separator === -1) {
    return { actionId: customId };
  }
  const actionId = customId.slice(0, separator);
  if (!actionId) {
    throw new Error("Discord custom_id action id is invalid");
  }
  return {
    actionId,
    value: customId.slice(separator + DISCORD_CUSTOM_ID_SEPARATOR.length)
  };
}

export function discordMessengerEvent(
  input: ChatSdkMessengerEventInput,
  definition: NormalizedMessengerDefinition
) {
  const event = defaultDiscordMessengerEvent(definition, input);
  const raw = interactionFromRaw(input.command?.raw ?? input.action?.raw);
  if (raw) {
    const thread = messengerThreadFromInteraction(raw);
    if (thread) {
      return { ...event, thread };
    }
  }
  return event;
}

export function parseDiscordSlashCommand(
  name: string,
  options: DiscordCommandOption[] = []
): { command: string; text: string } {
  const commandParts = [name.startsWith("/") ? name : `/${name}`];
  const valueParts: string[] = [];

  const collect = (items: DiscordCommandOption[]) => {
    for (const option of items) {
      if (option.value !== undefined) {
        valueParts.push(String(option.value));
        continue;
      }
      if (option.options && option.options.length > 0) {
        commandParts.push(option.name);
        collect(option.options);
      }
    }
  };

  collect(options);
  return { command: commandParts.join(" "), text: valueParts.join(" ") };
}

export interface VerifyDiscordInteractionRequestOptions {
  body: ArrayBuffer;
  publicKey: string;
  signature: string | null;
  timestamp: string | null;
  timestampToleranceMs?: number;
}

export async function verifyDiscordInteractionRequest(
  options: VerifyDiscordInteractionRequestOptions
): Promise<boolean> {
  if (!options.signature || !options.timestamp) return false;
  if (!DISCORD_SIGNATURE_PATTERN.test(options.signature)) return false;
  const timestampSeconds = Number(options.timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;

  const toleranceMs = normalizeDiscordTimestampTolerance(
    options.timestampToleranceMs
  );
  if (toleranceMs > 0) {
    const ageMs = Math.abs(Date.now() - timestampSeconds * 1_000);
    if (ageMs > toleranceMs) return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    bytesToArrayBuffer(
      hexToBytes(normalizeDiscordPublicKey(options.publicKey))
    ),
    { name: "Ed25519" },
    false,
    ["verify"]
  );
  const timestampBytes = new TextEncoder().encode(options.timestamp);
  const bodyBytes = new Uint8Array(options.body);
  const signed = new Uint8Array(timestampBytes.length + bodyBytes.length);
  signed.set(timestampBytes);
  signed.set(bodyBytes, timestampBytes.length);

  return crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    bytesToArrayBuffer(hexToBytes(options.signature)),
    bytesToArrayBuffer(signed)
  );
}

export function normalizeDiscordPublicKey(publicKey: string): string {
  const normalized = publicKey.trim().toLowerCase();
  if (!DISCORD_PUBLIC_KEY_PATTERN.test(normalized)) {
    throw new Error("Discord publicKey must be a 64-character hex string");
  }
  return normalized;
}

export function splitDiscordMessageText(
  text: string,
  limit = DISCORD_FOLLOWUP_CHUNK_LIMIT
): string[] {
  if (!text.trim()) {
    return [];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n\n", limit);
    if (splitAt < Math.floor(limit * 0.5)) {
      splitAt = remaining.lastIndexOf("\n", limit);
    }
    if (splitAt < Math.floor(limit * 0.5)) {
      splitAt = remaining.lastIndexOf(" ", limit);
    }
    if (splitAt < Math.floor(limit * 0.5)) {
      splitAt = limit;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function resolveDiscordInteractionsOptions(
  options: DiscordMessengerOptions["interactions"]
): Required<DiscordInteractionsOptions> {
  if (options === false) {
    return {
      enabled: false,
      timestampToleranceMs: DISCORD_INTERACTION_TIMESTAMP_TOLERANCE_MS
    };
  }
  if (options === true || options === undefined) {
    return {
      enabled: true,
      timestampToleranceMs: DISCORD_INTERACTION_TIMESTAMP_TOLERANCE_MS
    };
  }

  return {
    enabled: options.enabled ?? true,
    timestampToleranceMs:
      options.timestampToleranceMs ?? DISCORD_INTERACTION_TIMESTAMP_TOLERANCE_MS
  };
}

function normalizeDiscordTimestampTolerance(value: number | undefined): number {
  const tolerance = value ?? DISCORD_INTERACTION_TIMESTAMP_TOLERANCE_MS;
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    throw new Error("Discord timestampToleranceMs must be a positive number");
  }
  return tolerance;
}

async function readDiscordInteractionBody(
  request: Request
): Promise<ArrayBuffer | Response> {
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const size = Number(contentLength);
    if (!Number.isFinite(size) || size > DISCORD_INTERACTION_BODY_LIMIT_BYTES) {
      return new Response("Discord interaction body too large", {
        status: 413
      });
    }
  }

  if (!request.body) {
    const body = await request.arrayBuffer();
    if (body.byteLength > DISCORD_INTERACTION_BODY_LIMIT_BYTES) {
      return new Response("Discord interaction body too large", {
        status: 413
      });
    }
    return body;
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > DISCORD_INTERACTION_BODY_LIMIT_BYTES) {
      await reader.cancel();
      return new Response("Discord interaction body too large", {
        status: 413
      });
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytesToArrayBuffer(body);
}

function selectedDiscordComponentValue(
  data: DiscordInteractionData | undefined
): string | undefined {
  if (!data?.values || data.values.length === 0) {
    return undefined;
  }
  return data.values.length === 1
    ? data.values[0]
    : JSON.stringify(data.values);
}

function interactionSurfaceId(interactionId: string): string {
  return `discord:interaction:${interactionId}`;
}

function interactionResponseContextKey(surfaceId: string): string {
  return `discord:interaction-response:${surfaceId}`;
}

function validateDiscordCustomId(customId: string): void {
  if (customId.length === 0 || customId.length > DISCORD_CUSTOM_ID_MAX_LENGTH) {
    throw new Error(
      `Discord custom_id must be 1-${DISCORD_CUSTOM_ID_MAX_LENGTH} characters`
    );
  }
}

function toDiscordAuthor(user: DiscordUser) {
  return {
    fullName: user.global_name || user.username,
    isBot: user.bot ?? false,
    isMe: false,
    userId: user.id,
    userName: user.username
  };
}

function redactDiscordInteraction(
  interaction: DiscordInteraction
): Omit<DiscordInteraction, "token"> {
  const { token: _token, ...redacted } = interaction;
  return redacted;
}

function interactionFromRaw(raw: unknown): DiscordInteraction | null {
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const candidate = raw as Partial<DiscordInteraction>;
  if (typeof candidate.id !== "string" || typeof candidate.type !== "number") {
    return null;
  }
  return candidate as DiscordInteraction;
}

function messengerThreadFromInteraction(interaction: DiscordInteraction): {
  channelId?: string;
  id: string;
  isDirectMessage: boolean;
  providerThreadId: string;
} | null {
  const interactionChannelId =
    interaction.channel_id ?? interaction.channel?.id;
  if (!interactionChannelId) return null;
  const guildId = interaction.guild_id ?? "@me";
  const channel = interaction.channel;
  const isThread = channel
    ? DISCORD_THREAD_CHANNEL_TYPES.has(channel.type)
    : false;
  const parentChannelId =
    isThread && channel?.parent_id ? channel.parent_id : interactionChannelId;
  const id = [
    "discord",
    guildId,
    parentChannelId,
    isThread ? interactionChannelId : undefined
  ]
    .filter(Boolean)
    .join(":");
  return {
    channelId: ["discord", guildId, parentChannelId].join(":"),
    id,
    isDirectMessage: guildId === "@me",
    providerThreadId: id
  };
}

function defaultDiscordMessengerEvent(
  definition: NormalizedMessengerDefinition,
  input: ChatSdkMessengerEventInput
) {
  return defaultChatSdkEvent(definition, input);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
