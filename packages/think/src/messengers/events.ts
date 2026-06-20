import type { UIMessage } from "ai";

export type MessengerEventKind =
  | "direct-message"
  | "mention"
  | "subscribed-message"
  | "command"
  | "action"
  | "reaction"
  | "delivery-event";

export interface MessengerAuthor {
  fullName?: string;
  isBot?: boolean | "unknown";
  isMe?: boolean;
  userId: string;
  userName?: string;
}

export interface MessengerAttachment {
  data?: ArrayBuffer;
  fetch?: () => Promise<ArrayBuffer>;
  id?: string;
  mediaType?: string;
  name?: string;
  raw?: unknown;
  size?: number;
  text?: string;
  url?: string;
}

export interface MessengerThread {
  channelId?: string;
  channelName?: string;
  id: string;
  isDirectMessage: boolean;
  providerThreadId: string;
  title?: string;
}

export interface MessengerMessage {
  attachments: MessengerAttachment[];
  author: MessengerAuthor;
  createdAt?: Date;
  id: string;
  isMention?: boolean;
  providerMessageId: string;
  raw?: unknown;
  text: string;
}

export interface MessengerAction {
  actionId: string;
  messageId?: string;
  providerActionId?: string;
  raw?: unknown;
  user?: MessengerAuthor;
  value?: string;
}

export interface MessengerCommand {
  command: string;
  providerCommandId?: string;
  raw?: unknown;
  text?: string;
  user?: MessengerAuthor;
  values?: Record<string, unknown>;
}

export interface MessengerReaction {
  added: boolean;
  emoji: string;
  messageId: string;
  raw?: unknown;
  user?: MessengerAuthor;
}

export interface MessengerCapabilities {
  canEditMessages?: boolean;
  canStream?: boolean;
  maxMessageLength?: number;
  supportsActions?: boolean;
  supportsAttachments?: boolean;
  supportsEphemeral?: boolean;
}

export interface MessengerContext {
  action?: MessengerAction;
  author?: MessengerAuthor;
  capabilities: MessengerCapabilities;
  command?: MessengerCommand;
  kind: MessengerEventKind;
  message?: MessengerMessage;
  messengerId: string;
  provider: string;
  reaction?: MessengerReaction;
  thread: MessengerThread;
}

export interface MessengerEvent extends MessengerContext {
  raw?: unknown;
}

export function messengerContextFromEvent(
  event: MessengerEvent
): MessengerContext {
  return {
    action: event.action,
    author:
      event.message?.author ??
      event.action?.user ??
      event.command?.user ??
      event.reaction?.user,
    capabilities: event.capabilities,
    command: event.command,
    kind: event.kind,
    message: event.message,
    messengerId: event.messengerId,
    provider: event.provider,
    reaction: event.reaction,
    thread: event.thread
  };
}

export function serializableMessengerEvent(
  event: MessengerEvent
): MessengerEvent {
  return {
    capabilities: { ...event.capabilities },
    kind: event.kind,
    messengerId: event.messengerId,
    provider: event.provider,
    thread: { ...event.thread },
    action: event.action
      ? {
          actionId: event.action.actionId,
          messageId: event.action.messageId,
          providerActionId: event.action.providerActionId,
          user: event.action.user ? { ...event.action.user } : undefined,
          value: event.action.value
        }
      : undefined,
    command: event.command
      ? {
          command: event.command.command,
          providerCommandId: event.command.providerCommandId,
          text: event.command.text,
          user: event.command.user ? { ...event.command.user } : undefined,
          values: event.command.values ? { ...event.command.values } : undefined
        }
      : undefined,
    message: event.message
      ? {
          attachments: event.message.attachments.map((attachment) => ({
            id: attachment.id,
            mediaType: attachment.mediaType,
            name: attachment.name,
            size: attachment.size,
            text: attachment.text,
            url: attachment.url
          })),
          author: { ...event.message.author },
          createdAt: event.message.createdAt,
          id: event.message.id,
          isMention: event.message.isMention,
          providerMessageId: event.message.providerMessageId,
          text: event.message.text
        }
      : undefined,
    reaction: event.reaction
      ? {
          added: event.reaction.added,
          emoji: event.reaction.emoji,
          messageId: event.reaction.messageId,
          user: event.reaction.user ? { ...event.reaction.user } : undefined
        }
      : undefined
  };
}

export function toMessengerUserMessage(event: MessengerEvent): UIMessage {
  const message = event.message;
  if (event.action) {
    const user = event.action.user;
    const displayName = user?.fullName || user?.userName || user?.userId;
    const details = [
      `Action selected: ${event.action.actionId}`,
      event.action.value ? `Value: ${event.action.value}` : undefined,
      event.action.messageId
        ? `Source message: ${event.action.messageId}`
        : undefined
    ].filter(Boolean);
    const text = displayName
      ? `${displayName}: ${details.join("\n")}`
      : details.join("\n");

    return {
      id: [
        event.messengerId,
        "action",
        event.thread.id,
        event.action.providerActionId,
        event.action.messageId,
        event.action.actionId
      ]
        .filter(Boolean)
        .join(":"),
      role: "user",
      parts: [{ type: "text", text }],
      metadata: {
        messenger: messengerContextFromEvent(event)
      }
    } as UIMessage;
  }

  if (event.command) {
    const user = event.command.user;
    const displayName = user?.fullName || user?.userName || user?.userId;
    const details = [
      `Slash command: ${event.command.command}`,
      event.command.text ? `Text: ${event.command.text}` : undefined
    ].filter(Boolean);
    const text = displayName
      ? `${displayName}: ${details.join("\n")}`
      : details.join("\n");

    return {
      id: [
        event.messengerId,
        "command",
        event.thread.id,
        commandEventId(event.command)
      ]
        .filter(Boolean)
        .join(":"),
      role: "user",
      parts: [{ type: "text", text }],
      metadata: {
        messenger: messengerContextFromEvent(event)
      }
    } as UIMessage;
  }

  if (event.reaction) {
    const user = event.reaction.user;
    const displayName = user?.fullName || user?.userName || user?.userId;
    const details = [
      `Reaction ${event.reaction.added ? "added" : "removed"}: ${event.reaction.emoji}`,
      `Source message: ${event.reaction.messageId}`
    ];
    const text = displayName
      ? `${displayName}: ${details.join("\n")}`
      : details.join("\n");

    return {
      id: [
        event.messengerId,
        "reaction",
        event.thread.id,
        event.reaction.messageId,
        event.reaction.emoji,
        event.reaction.user?.userId ?? "unknown-user",
        event.reaction.added ? "added" : "removed"
      ].join(":"),
      role: "user",
      parts: [{ type: "text", text }],
      metadata: {
        messenger: messengerContextFromEvent(event)
      }
    } as UIMessage;
  }

  if (!message) {
    throw new Error(`Messenger event ${event.kind} does not contain a message`);
  }

  const text = message.text.trim();
  const displayName =
    message.author.fullName || message.author.userName || message.author.userId;
  const content =
    event.thread.isDirectMessage || !displayName
      ? text
      : `${displayName}: ${text}`;
  const attachmentText = describeAttachments(message.attachments);
  const fullText = [content || text, attachmentText]
    .filter(Boolean)
    .join("\n\n");

  return {
    id: `${event.messengerId}:${message.id}`,
    role: "user",
    parts: [{ type: "text", text: fullText }],
    metadata: {
      messenger: messengerContextFromEvent(event)
    }
  } as UIMessage;
}

function commandEventId(command: MessengerCommand): string {
  return [
    stableIdPart(command.providerCommandId ?? rawStringId(command.raw)),
    stableIdPart(command.command),
    command.user?.userId ?? "unknown-user",
    stableIdPart(command.text ?? "no-text")
  ].join(":");
}

function stableIdPart(value: string | undefined): string {
  if (!value) {
    return "unknown";
  }

  const safe = value.replace(/[^a-zA-Z0-9:_/-]/g, "_");
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

function rawStringId(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== "object") {
    return undefined;
  }

  const candidate = raw as { id?: unknown };
  return typeof candidate.id === "string" ? candidate.id : undefined;
}

function describeAttachments(attachments: MessengerAttachment[]): string {
  if (attachments.length === 0) {
    return "";
  }

  const lines = attachments.map((attachment, index) => {
    const label = attachment.name || attachment.id || `attachment ${index + 1}`;
    const details = [
      attachment.mediaType,
      attachment.size === undefined ? undefined : `${attachment.size} bytes`,
      attachment.url
    ].filter(Boolean);
    return `- ${label}${details.length ? ` (${details.join(", ")})` : ""}`;
  });

  return ["Attachments:", ...lines].join("\n");
}
