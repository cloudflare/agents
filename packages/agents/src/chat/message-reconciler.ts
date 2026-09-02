/**
 * Message reconciliation — pure functions for aligning client messages
 * with server state during persistence.
 *
 * Three strategies applied in order:
 * 1. Reconcile assistant IDs (exact match → toolCallId → content-key)
 * 2. Merge server-known tool outputs into the resolved message
 * 3. Per-message toolCallId dedup for persistence
 */

import type { UIMessage } from "ai";

/**
 * Reconcile incoming client messages against server state.
 *
 * 1. Reconciles assistant IDs: exact match → toolCallId match → content-key match
 * 2. Merges server-known tool outputs into incoming messages that still
 *    show stale states (input-available, approval-requested, approval-responded).
 *    Outputs come from the server row the message resolved to; a message that
 *    resolved to no row may still merge from an unambiguous toolCallId whose
 *    input is identical.
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
  const withReconciledAssistantIds = reconcileAssistantIds(
    incoming,
    serverMessages,
    sanitizeForContentKey
  );
  return mergeServerToolOutputs(withReconciledAssistantIds, serverMessages);
}

/**
 * For a single message, resolve its ID by matching toolCallId against server state.
 * Prevents duplicate DB rows when client IDs differ from server IDs.
 *
 * @deprecated Unsafe when a provider reuses a toolCallId across turns. This
 * scans the whole conversation and claims nothing, so a later assistant can
 * adopt an earlier row's ID and overwrite it on upsert (#1992). Use
 * {@link reconcileMessages}, which claims server rows one-to-one over the
 * whole transcript. Retained only for backwards compatibility; no longer used
 * by `@cloudflare/ai-chat` or `@cloudflare/think`.
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
 * Merge a freshly-reconstructed orphaned partial onto the assistant message
 * that already owns its target id (the orphan-persist **(c)** step).
 *
 * Used by hosts whose store can hold an assistant row for the SAME id BEFORE
 * the stream finalizes — e.g. an early persist at tool-approval time, or a
 * continuation resuming the prior assistant message. On recovery the engine
 * replays the same chunks, so a naive append would leave two parts per tool
 * call. The merge therefore:
 *
 *   - keeps ALL existing parts (the persisted row is authoritative for tool
 *     parts that had a client result applied IN PLACE — that result lives only
 *     in storage, never in the chunk stream, so a whole-message replace would
 *     clobber it);
 *   - appends only the reconstructed parts whose `toolCallId` is NOT already
 *     present (dedup by tool-call identity);
 *   - overlays the incoming metadata onto the existing metadata (incoming wins
 *     on conflicts), falling back to whichever side is present.
 *
 * The result carries the INCOMING message's id/role (the caller has already
 * resolved the incoming id to the existing row's id via the (b) target-id
 * step), so it is safe to write straight back through `updateMessage`.
 *
 * Hosts whose orphan persist only ever runs at stream finalize (no early/
 * mid-stream row for the same id) never hit the merge branch and don't need
 * this — a plain append/replace is already dedup-safe because the shared
 * reconstruction (`StreamAccumulator` / `applyChunkToParts`) is idempotent by
 * `toolCallId`.
 */
export function reconcileOrphanPartial(
  existing: UIMessage,
  incoming: UIMessage
): UIMessage {
  const existingToolCallIds = new Set(
    existing.parts
      .filter((p): p is typeof p & { toolCallId: string } => "toolCallId" in p)
      .map((p) => p.toolCallId)
  );
  const newParts = incoming.parts.filter(
    (p) => !("toolCallId" in p && existingToolCallIds.has(p.toolCallId))
  );

  const merged: UIMessage = {
    ...incoming,
    parts: [...existing.parts, ...newParts]
  };
  if (existing.metadata) {
    merged.metadata = incoming.metadata
      ? { ...existing.metadata, ...incoming.metadata }
      : existing.metadata;
  }
  return merged;
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
  // Index resolved tool parts by message ID first, then toolCallId. Providers
  // may reuse toolCallIds across turns, so a conversation-wide index can merge
  // an older result into a newer assistant message.
  const serverResolvedPartsByMessage = new Map<
    string,
    Map<string, Record<string, unknown>>
  >();
  // Conversation-wide index used as a per-part fallback. `null` marks a
  // toolCallId that resolved on more than one server row — too ambiguous to
  // merge from.
  const resolvedByToolCallId = new Map<
    string,
    Record<string, unknown> | null
  >();

  for (const msg of serverMessages) {
    if (msg.role !== "assistant") continue;
    const resolvedParts = new Map<string, Record<string, unknown>>();
    for (const part of msg.parts) {
      const record = part as Record<string, unknown>;
      if (isResolvedToolPart(record)) {
        const toolCallId = record.toolCallId as string;
        resolvedParts.set(toolCallId, record);
        resolvedByToolCallId.set(
          toolCallId,
          resolvedByToolCallId.has(toolCallId) ? null : record
        );
      }
    }
    if (resolvedParts.size > 0) {
      serverResolvedPartsByMessage.set(msg.id, resolvedParts);
    }
  }

  if (serverResolvedPartsByMessage.size === 0) return incoming;

  return incoming.map((msg) => {
    if (msg.role !== "assistant") return msg;
    const ownResolvedParts = serverResolvedPartsByMessage.get(msg.id);

    let hasChanges = false;
    const updatedParts = msg.parts.map((part) => {
      const record = part as Record<string, unknown>;
      if (!isPendingToolPart(record)) return part;

      // Prefer the row this message resolved to. If that row does not carry
      // this call — the message resolved to no row at all, or the result was
      // persisted on a different row — fall back to the conversation-wide
      // index, but only for a call carrying an identical input. Same
      // toolCallId AND same input means the same call, whereas a provider
      // reusing an ID for a NEW call carries different input. Without the
      // fallback a pending part persists stuck in a pre-terminal state,
      // reintroducing the dangling orphan of #1381 and losing the server's
      // output-error / output-denied that #1623 hardened.
      const toolCallId = record.toolCallId as string;
      const server =
        ownResolvedParts?.get(toolCallId) ??
        fallbackResolvedPart(resolvedByToolCallId, record);

      if (server) {
        hasChanges = true;
        // Overlay the server's resolved state, keeping the client part's
        // identity/input. Carry ONLY the result field that belongs to the
        // server's terminal state — so a stray `output` left on an
        // `output-error` part can't ride along and be misread as a result.
        const merged: Record<string, unknown> = {
          ...part,
          state: server.state
        };
        if (server.state === "output-available") {
          if ("output" in server) merged.output = server.output;
        } else if (server.state === "output-error") {
          if ("errorText" in server) merged.errorText = server.errorText;
        } else if (server.state === "output-denied") {
          if ("approval" in server) merged.approval = server.approval;
        }
        return merged;
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

    if (incomingMessage.role !== "assistant") {
      return incomingMessage;
    }

    const incomingToolCallIds = getToolCallIds(incomingMessage);
    if (incomingToolCallIds.size > 0) {
      for (let i = 0; i < serverMessages.length; i++) {
        if (claimedServerIndices.has(i)) continue;

        const serverMessage = serverMessages[i];
        if (
          serverMessage.role === "assistant" &&
          serverMessage.parts.some(
            (part) =>
              "toolCallId" in part &&
              typeof part.toolCallId === "string" &&
              incomingToolCallIds.has(part.toolCallId)
          )
        ) {
          claimedServerIndices.add(i);
          return { ...incomingMessage, id: serverMessage.id };
        }
      }
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

/** A server-side tool part that has reached a terminal state. */
function isResolvedToolPart(record: Record<string, unknown>): boolean {
  return (
    "toolCallId" in record &&
    "state" in record &&
    (record.state === "output-available" ||
      record.state === "output-error" ||
      record.state === "output-denied")
  );
}

/** A client-side tool part still waiting on a result. */
function isPendingToolPart(record: Record<string, unknown>): boolean {
  return (
    "toolCallId" in record &&
    "state" in record &&
    (record.state === "input-available" ||
      record.state === "approval-requested" ||
      record.state === "approval-responded")
  );
}

/**
 * Resolve a server part for an incoming tool part that never claimed a server
 * row. Requires an unambiguous toolCallId AND an identical input, so a
 * provider that reuses a toolCallId for a genuinely new call (different
 * input) cannot inherit the previous turn's result.
 */
function fallbackResolvedPart(
  resolvedByToolCallId: Map<string, Record<string, unknown> | null>,
  record: Record<string, unknown>
): Record<string, unknown> | undefined {
  const server = resolvedByToolCallId.get(record.toolCallId as string);
  if (!server) return undefined;
  return sameToolInput(record.input, server.input) ? server : undefined;
}

/**
 * Structural comparison of two tool inputs. Both absent counts as equal, which
 * keeps the pre-existing permissive behaviour for tools that take no input.
 */
function sameToolInput(a: unknown, b: unknown): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function getToolCallIds(message: UIMessage): Set<string> {
  return new Set(
    message.parts.flatMap((part) =>
      "toolCallId" in part && typeof part.toolCallId === "string"
        ? [part.toolCallId]
        : []
    )
  );
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
