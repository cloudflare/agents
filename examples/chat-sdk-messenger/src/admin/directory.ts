import type { FiberInspection } from "agents";
import type { Message, Thread } from "chat";

export type AdminConversation = {
  threadId: string;
  conversationName: string;
  provider: string;
  title: string;
  lastMessagePreview?: string;
  createdAt: number;
  lastMessageAt: number;
};

export type AdminReplyJob = {
  fiberId: string;
  status: FiberInspection["status"];
  threadId?: string;
  messageId?: string;
  createdAt: number;
  startedAt?: number;
  settledAt?: number;
  error?: string;
};

export type AdminSetupInfo = {
  webhookPath: string;
  agentName: string;
  telegramConfigured: boolean;
  telegramUserName: string;
};

export type AdminConversationRow = {
  thread_id: string;
  conversation_name: string;
  provider: string;
  title: string;
  last_message_preview: string | null;
  created_at: number;
  last_message_at: number;
};

export function providerFromThreadId(threadId: string): string {
  return threadId.split(":")[0] || "unknown";
}

export function conversationTitle(thread: Thread): string {
  return `${providerFromThreadId(thread.id)}:${thread.id.split(":")[1] ?? thread.id}`;
}

export function messagePreview(message: Message): string {
  return message.text.trim().slice(0, 160);
}

export function adminConversationFromRow(
  row: AdminConversationRow
): AdminConversation {
  return {
    threadId: row.thread_id,
    conversationName: row.conversation_name,
    provider: row.provider,
    title: row.title,
    lastMessagePreview: row.last_message_preview ?? undefined,
    createdAt: row.created_at,
    lastMessageAt: row.last_message_at
  };
}

function metadataString(
  metadata: Record<string, unknown> | null | undefined,
  key: string
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

export function adminReplyJobFromFiber(fiber: FiberInspection): AdminReplyJob {
  return {
    fiberId: fiber.fiberId,
    status: fiber.status,
    threadId: metadataString(fiber.metadata, "threadId"),
    messageId: metadataString(fiber.metadata, "messageId"),
    createdAt: fiber.createdAt,
    startedAt: fiber.startedAt,
    settledAt: fiber.settledAt,
    error: fiber.error
  };
}
