import type { UIMessage } from "ai";

export type MessengerEventKind =
  | "direct-message"
  | "mention"
  | "subscribed-message"
  | "action"
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
  raw?: unknown;
  user?: MessengerAuthor;
  value?: string;
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
  kind: MessengerEventKind;
  message?: MessengerMessage;
  messengerId: string;
  provider: string;
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
    author: event.message?.author ?? event.action?.user,
    capabilities: event.capabilities,
    kind: event.kind,
    message: event.message,
    messengerId: event.messengerId,
    provider: event.provider,
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
          user: event.action.user ? { ...event.action.user } : undefined,
          value: event.action.value
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
