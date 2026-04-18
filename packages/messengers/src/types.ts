/**
 * Core types for the messengers package.
 *
 * These define the normalized message format that all platform adapters
 * produce (inbound) and consume (outbound). The goal is not to make
 * platforms identical — it is to give the agent a consistent interface
 * while preserving access to raw platform payloads when needed.
 */

// ---------------------------------------------------------------------------
// Channel references
// ---------------------------------------------------------------------------

/**
 * Identifies a destination on a specific platform. The shape varies by
 * platform — Slack needs a channel + thread_ts, Telegram needs a chat_id,
 * Discord needs a channel + message ID for threads.
 */
export type ChannelRef =
  | SlackChannelRef
  | TelegramChannelRef
  | GenericChannelRef;

export interface SlackChannelRef {
  platform: "slack";
  channelId: string;
  threadTs?: string;
  teamId?: string;
}

export interface TelegramChannelRef {
  platform: "telegram";
  chatId: number;
  messageThreadId?: number;
}

export interface GenericChannelRef {
  platform: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Inbound: normalized messages from any platform
// ---------------------------------------------------------------------------

export interface Author {
  id: string;
  name: string;
  isBot: boolean;
}

export interface Attachment {
  type: "file" | "image" | "video" | "audio";
  url?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
}

export interface NormalizedMessage {
  id: string;
  text: string;
  author: Author;
  timestamp: number;
  attachments?: Attachment[];
  isMention?: boolean;
  replyToMessageId?: string;
}

// ---------------------------------------------------------------------------
// Inbound events
// ---------------------------------------------------------------------------

/**
 * Discriminated union of all inbound event types. Narrowing on `type`
 * guarantees the presence of the corresponding payload field:
 *
 *   if (event.type === "message") {
 *     event.message // NormalizedMessage — guaranteed
 *   }
 */
export type InboundEvent =
  | MessageEvent
  | ReactionInboundEvent
  | InteractionInboundEvent
  | CommandInboundEvent
  | MemberJoinedEvent
  | UnknownEvent;

interface InboundEventBase {
  platform: string;
  channel: ChannelRef;
  /** The original, unmodified platform payload. */
  raw: unknown;
}

export interface MessageEvent extends InboundEventBase {
  type: "message";
  message: NormalizedMessage;
}

export interface ReactionInboundEvent extends InboundEventBase {
  type: "reaction";
  reaction: ReactionEvent;
}

export interface InteractionInboundEvent extends InboundEventBase {
  type: "interaction";
  interaction: InteractionEvent;
}

export interface CommandInboundEvent extends InboundEventBase {
  type: "command";
  command: CommandEvent;
}

export interface MemberJoinedEvent extends InboundEventBase {
  type: "member_joined";
}

export interface UnknownEvent extends InboundEventBase {
  type: "unknown";
}

export interface ReactionEvent {
  emoji: string;
  added: boolean;
  userId: string;
  messageId: string;
}

export interface InteractionEvent {
  actionId: string;
  value?: string;
  userId: string;
  triggerId?: string;
}

export interface CommandEvent {
  command: string;
  text: string;
  userId: string;
}

// ---------------------------------------------------------------------------
// Outbound: messages the agent sends to platforms
// ---------------------------------------------------------------------------

export interface Button {
  id: string;
  label: string;
  style?: "primary" | "danger" | "default";
  url?: string;
  value?: string;
}

export type MessageBlock =
  | { type: "text"; content: string }
  | { type: "code"; content: string; language?: string }
  | { type: "image"; url: string; alt?: string }
  | { type: "actions"; buttons: Button[] }
  | {
      type: "fields";
      items: Array<{ label: string; value: string }>;
    };

/**
 * A message the agent wants to send to a platform. Adapters accept all
 * formats and convert to the platform's native representation.
 */
export type OutboundMessage =
  | string
  | { markdown: string }
  | { blocks: MessageBlock[] };

export interface SentMessage {
  id: string;
  platform: string;
  channel: ChannelRef;
  /** The final text content as delivered, if available. */
  text?: string;
}

// ---------------------------------------------------------------------------
// Platform capabilities
// ---------------------------------------------------------------------------

export interface PlatformCapabilities {
  /** How the platform handles streaming responses. */
  streaming: "native" | "post-edit" | "none";
  /** Maximum characters in a single message. */
  maxMessageLength: number;
  /** What rich text the platform supports. */
  richText: "full-html" | "markdown" | "mrkdwn" | "plain";
  /** What interactive elements work. */
  interactiveElements: "full" | "buttons" | "none";
  /** File upload support, or false if unsupported. */
  fileUpload: { maxSize: number } | false;
  /** How threading works on this platform. */
  threading: "native" | "reply-to" | "flat";
  /** Whether typing indicators are supported. */
  typing: boolean;
  /** Whether posted messages can be edited. */
  editAfterPost: boolean;
  /** Whether reactions are supported. */
  reactions: boolean;
}
