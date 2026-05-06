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
 * Prevents duplicate DB rows when client IDs differ from server IDs, while
 * avoiding overwrites from providers that reuse toolCallIds across turns.
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
      const existing = findCompatibleMessageByToolCallId(
        message,
        serverMessages,
        toolCallId
      );
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
  return incoming.map((msg) => {
    if (msg.role !== "assistant") return msg;

    let hasChanges = false;
    const updatedParts = msg.parts.map((part) => {
      if (
        "toolCallId" in part &&
        "state" in part &&
        (part.state === "input-available" ||
          part.state === "approval-requested" ||
          part.state === "approval-responded")
      ) {
        const output = findCompatibleServerToolOutput(
          msg,
          serverMessages,
          part.toolCallId as string
        );
        if (output.found) {
          hasChanges = true;
          return {
            ...part,
            state: "output-available" as const,
            output: output.value
          };
        }
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

function findCompatibleServerToolOutput(
  incoming: UIMessage,
  serverMessages: readonly UIMessage[],
  toolCallId: string
): { found: true; value: unknown } | { found: false } {
  for (const serverMessage of serverMessages) {
    if (serverMessage.role !== "assistant") continue;
    if (!shouldAdoptServerIdForToolMerge(incoming, serverMessage, toolCallId)) {
      continue;
    }

    const part = findToolPart(serverMessage, toolCallId);
    if (
      part &&
      "state" in part &&
      part.state === "output-available" &&
      "output" in part
    ) {
      return { found: true, value: (part as { output: unknown }).output };
    }
  }

  return { found: false };
}

function shouldAdoptServerIdForToolMerge(
  incoming: UIMessage,
  existing: UIMessage,
  toolCallId: string
): boolean {
  const incomingPart = findToolPart(incoming, toolCallId);
  const existingPart = findToolPart(existing, toolCallId);
  if (!incomingPart || !existingPart) return false;

  if (isTerminalToolPart(incomingPart) && isTerminalToolPart(existingPart)) {
    return (
      normalizedMessageParts(incoming) === normalizedMessageParts(existing)
    );
  }

  return toolPartsCompatibleForMerge(incomingPart, existingPart);
}

function toolPartsCompatibleForMerge(
  incomingPart: UIMessage["parts"][number],
  existingPart: UIMessage["parts"][number]
): boolean {
  if (incomingPart.type !== existingPart.type) return false;

  if (
    "toolName" in incomingPart &&
    "toolName" in existingPart &&
    incomingPart.toolName !== existingPart.toolName
  ) {
    return false;
  }

  if ("input" in incomingPart && "input" in existingPart) {
    return (
      JSON.stringify(incomingPart.input) === JSON.stringify(existingPart.input)
    );
  }

  return true;
}

function findToolPart(
  message: UIMessage,
  toolCallId: string
): UIMessage["parts"][number] | undefined {
  return message.parts.find(
    (part) => "toolCallId" in part && part.toolCallId === toolCallId
  );
}

function isTerminalToolPart(part: UIMessage["parts"][number]): boolean {
  if (!("state" in part)) return false;
  return (
    part.state === "output-available" ||
    part.state === "output-error" ||
    part.state === "output-denied"
  );
}

function normalizedMessageParts(message: UIMessage): string {
  return JSON.stringify(
    message.parts
      .filter((part) => part.type !== "step-start")
      .map((part) => {
        if (!("toolCallId" in part)) return part;
        return normalizeToolPart(part);
      })
  );
}

function normalizeToolPart(
  part: UIMessage["parts"][number]
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(part)) {
    if (key === "state" || key === "preliminary" || key === "approval")
      continue;
    normalized[key] = value;
  }
  return normalized;
}

function findCompatibleMessageByToolCallId(
  incoming: UIMessage,
  messages: readonly UIMessage[],
  toolCallId: string
): UIMessage | undefined {
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    if (shouldAdoptServerIdForToolMerge(incoming, msg, toolCallId)) {
      return msg;
    }
  }
  return undefined;
}
