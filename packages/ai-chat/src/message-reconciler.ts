/**
 * Message reconciliation — pure functions for aligning client messages
 * with server state during persistence.
 *
 * Three strategies applied in order:
 * 1. Merge server-known tool outputs into stale client messages
 * 2. Reconcile assistant IDs (exact match → content-key → toolCallId)
 * 3. Per-message toolCallId dedup for persistence
 */

import type { UIMessage } from "ai";

/**
 * Reconcile incoming client messages against server state.
 *
 * 1. Merges server-known tool outputs into incoming messages that still
 *    show stale states (input-available, approval-requested, approval-responded)
 * 2. Reconciles assistant IDs: exact match → content-key match → toolCallId match
 *
 * @param incoming - Messages from the client
 * @param serverMessages - Current server-side messages (source of truth)
 * @param sanitizeForContentKey - Function to sanitize a message before computing
 *   its content key (typically strips ephemeral provider metadata)
 * @returns Reconciled messages ready for persistence
 */
export function reconcileMessages(
  incoming: UIMessage[],
  serverMessages: readonly UIMessage[],
  sanitizeForContentKey?: (message: UIMessage) => UIMessage
): UIMessage[] {
  const withMergedToolOutputs = mergeServerToolOutputs(
    incoming,
    serverMessages
  );
  return reconcileAssistantIds(
    withMergedToolOutputs,
    serverMessages,
    sanitizeForContentKey
  );
}

/**
 * For a single message, resolve its ID by matching toolCallId against server state.
 * Prevents duplicate DB rows when client IDs differ from server IDs.
 * Tool call IDs are unique per conversation, so matching is safe regardless of state.
 */
export function resolveToolMergeId(
  message: UIMessage,
  serverMessages: readonly UIMessage[]
): UIMessage {
  if (message.role !== "assistant") {
    return message;
  }

  for (const part of message.parts) {
    if ("toolCallId" in part && part.toolCallId) {
      const toolCallId = part.toolCallId as string;
      const existing = findMessageByToolCallId(serverMessages, toolCallId);
      if (existing && existing.id !== message.id) {
        return { ...message, id: existing.id };
      }
    }
  }

  return message;
}

/**
 * Content key for assistant messages used for dedup of identical short replies.
 * Returns JSON of sanitized parts, or undefined for non-assistant messages.
 */
export function assistantContentKey(
  message: UIMessage,
  sanitize?: (message: UIMessage) => UIMessage
): string | undefined {
  if (message.role !== "assistant") {
    return undefined;
  }
  const sanitized = sanitize ? sanitize(message) : message;
  return JSON.stringify(sanitized.parts);
}

function mergeServerToolOutputs(
  incoming: UIMessage[],
  serverMessages: readonly UIMessage[]
): UIMessage[] {
  const serverToolOutputs = new Map<string, unknown>();
  for (const msg of serverMessages) {
    if (msg.role !== "assistant") continue;
    for (const part of msg.parts) {
      if (
        "toolCallId" in part &&
        "state" in part &&
        part.state === "output-available" &&
        "output" in part
      ) {
        serverToolOutputs.set(
          part.toolCallId as string,
          (part as { output: unknown }).output
        );
      }
    }
  }

  if (serverToolOutputs.size === 0) return incoming;

  return incoming.map((msg) => {
    if (msg.role !== "assistant") return msg;

    let hasChanges = false;
    const updatedParts = msg.parts.map((part) => {
      if (
        "toolCallId" in part &&
        "state" in part &&
        (part.state === "input-available" ||
          part.state === "approval-requested" ||
          part.state === "approval-responded") &&
        serverToolOutputs.has(part.toolCallId as string)
      ) {
        hasChanges = true;
        return {
          ...part,
          state: "output-available" as const,
          output: serverToolOutputs.get(part.toolCallId as string)
        };
      }
      return part;
    }) as UIMessage["parts"];

    return hasChanges ? { ...msg, parts: updatedParts } : msg;
  });
}

function reconcileAssistantIds(
  incoming: UIMessage[],
  serverMessages: readonly UIMessage[],
  sanitize?: (message: UIMessage) => UIMessage
): UIMessage[] {
  if (serverMessages.length === 0) return incoming;

  const claimedServerIndices = new Set<number>();
  const exactMatchMap = new Map<number, number>();

  for (let i = 0; i < incoming.length; i++) {
    const serverIdx = serverMessages.findIndex(
      (sm, si) => !claimedServerIndices.has(si) && sm.id === incoming[i].id
    );
    if (serverIdx !== -1) {
      claimedServerIndices.add(serverIdx);
      exactMatchMap.set(i, serverIdx);
    }
  }

  return incoming.map((incomingMessage, incomingIdx) => {
    if (exactMatchMap.has(incomingIdx)) {
      return incomingMessage;
    }

    if (
      incomingMessage.role !== "assistant" ||
      hasToolCallPart(incomingMessage)
    ) {
      return incomingMessage;
    }

    const incomingKey = assistantContentKey(incomingMessage, sanitize);
    if (!incomingKey) {
      return incomingMessage;
    }

    for (let i = 0; i < serverMessages.length; i++) {
      if (claimedServerIndices.has(i)) continue;

      const serverMessage = serverMessages[i];
      if (
        serverMessage.role !== "assistant" ||
        hasToolCallPart(serverMessage)
      ) {
        continue;
      }

      if (assistantContentKey(serverMessage, sanitize) === incomingKey) {
        claimedServerIndices.add(i);
        return { ...incomingMessage, id: serverMessage.id };
      }
    }

    return incomingMessage;
  });
}

function hasToolCallPart(message: UIMessage): boolean {
  return message.parts.some((part) => "toolCallId" in part);
}

function findMessageByToolCallId(
  messages: readonly UIMessage[],
  toolCallId: string
): UIMessage | undefined {
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const part of msg.parts) {
      if ("toolCallId" in part && part.toolCallId === toolCallId) {
        return msg;
      }
    }
  }
  return undefined;
}
