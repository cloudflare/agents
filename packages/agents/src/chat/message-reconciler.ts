/**
 * Message reconciliation — pure functions for aligning client messages
 * with server state during persistence.
 *
 * Three strategies applied in order:
 * 1. Reconcile assistant IDs (exact match → same tool call → content-key)
 * 2. Merge server-known tool outputs into the resolved message
 * 3. Drop stale copies of assistants echoed in the same submit
 */

import type { UIMessage } from "ai";

/**
 * Reconcile incoming client messages against server state.
 *
 * 1. Reconciles assistant IDs: exact match → same tool call → content-key
 *    match. Each server row is claimed at most once, and a tool-call match
 *    requires the same toolCallId, tool and input, since providers may reuse
 *    toolCallIds across turns.
 * 2. Merges server-known tool outputs into incoming messages that still
 *    show stale states (input-available, approval-requested, approval-responded).
 *    Outputs come from the server row the message resolved to. A call that
 *    row does not carry may merge only from a server row no incoming message
 *    claimed, and only when exactly one such row holds the same tool call.
 * 3. Drops a stale copy of an assistant the same submit also echoes under its
 *    stored ID (see {@link dropStaleToolCopies}).
 *
 * @param incoming - Messages from the client
 * @param serverMessages - Current server-side messages (source of truth)
 * @param sanitizeForContentKey - Function to sanitize a message before computing
 *   its content key or comparing its tool calls against stored rows
 *   (typically the host's persistence sanitizer, so a tool input the host
 *   truncates on write compares equal to its stored form)
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
  return dropStaleToolCopies(
    mergeServerToolOutputs(
      withReconciledAssistantIds,
      serverMessages,
      sanitizeForContentKey
    ),
    serverMessages,
    sanitizeForContentKey
  );
}

/**
 * Drop a stale client copy of an assistant that the same submit also echoes
 * under its stored ID. Kept, the copy persists as a second row carrying the
 * same toolCallIds and reaches the next prompt as a duplicate tool call, which
 * providers that issue unique IDs reject.
 *
 * A message is dropped only when it claimed no server row, is not the last
 * submitted message (a new call awaiting its result sits there), and consists
 * solely of `step-start` parts and pending tool parts each matching the same
 * call already settled on a server row this submit claimed. Anything else is
 * kept.
 */
function dropStaleToolCopies(
  reconciled: UIMessage[],
  serverMessages: readonly UIMessage[],
  sanitize?: (message: UIMessage) => UIMessage
): UIMessage[] {
  const reconciledIds = new Set(reconciled.map((msg) => msg.id));
  const serverIds = new Set<string>();
  const settledOnClaimed = new Map<string, Record<string, unknown>[]>();
  for (const msg of serverMessages) {
    serverIds.add(msg.id);
    if (msg.role !== "assistant" || !reconciledIds.has(msg.id)) continue;
    for (const part of msg.parts) {
      const record = part as Record<string, unknown>;
      if (!isResolvedToolPart(record)) continue;
      const toolCallId = record.toolCallId as string;
      const settled = settledOnClaimed.get(toolCallId);
      if (settled) settled.push(record);
      else settledOnClaimed.set(toolCallId, [record]);
    }
  }
  if (settledOnClaimed.size === 0) return reconciled;

  const lastIndex = reconciled.length - 1;
  const kept = reconciled.filter((msg, index) => {
    if (index === lastIndex) return true;
    if (msg.role !== "assistant" || serverIds.has(msg.id)) return true;
    const comparable = sanitize ? sanitize(msg) : msg;
    let hasToolPart = false;
    for (const part of comparable.parts) {
      const record = part as Record<string, unknown>;
      if (record.type === "step-start") continue;
      if (
        typeof record.toolCallId !== "string" ||
        !(isPendingToolPart(record) || record.state === "input-streaming")
      ) {
        return true;
      }
      const settled = settledOnClaimed.get(record.toolCallId);
      if (!settled?.some((candidate) => sameToolCall(candidate, record))) {
        return true;
      }
      hasToolPart = true;
    }
    return !hasToolPart;
  });
  return kept.length === reconciled.length ? reconciled : kept;
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
  serverMessages: readonly UIMessage[],
  sanitize?: (message: UIMessage) => UIMessage
): UIMessage[] {
  // Index resolved tool parts by message ID first, then toolCallId. Providers
  // may reuse toolCallIds across turns, so a conversation-wide index can merge
  // an older result into a newer assistant message.
  const serverResolvedPartsByMessage = new Map<
    string,
    Map<string, Record<string, unknown>>
  >();
  // Per-part fallback candidates, from server rows that no incoming message
  // resolved to. A row an incoming message claimed belongs to that message;
  // its results must not be copied into a different message, which may be a
  // later call reusing the same toolCallId and input.
  const claimedIds = new Set(incoming.map((msg) => msg.id));
  const unclaimedResolvedByToolCallId = new Map<
    string,
    Record<string, unknown>[]
  >();

  for (const msg of serverMessages) {
    if (msg.role !== "assistant") continue;
    const resolvedParts = new Map<string, Record<string, unknown>>();
    for (const part of msg.parts) {
      const record = part as Record<string, unknown>;
      if (isResolvedToolPart(record)) {
        const toolCallId = record.toolCallId as string;
        resolvedParts.set(toolCallId, record);
        if (!claimedIds.has(msg.id)) {
          const candidates = unclaimedResolvedByToolCallId.get(toolCallId);
          if (candidates) candidates.push(record);
          else unclaimedResolvedByToolCallId.set(toolCallId, [record]);
        }
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
    let comparableParts: Map<string, Record<string, unknown>> | undefined;

    let hasChanges = false;
    const updatedParts = msg.parts.map((part) => {
      const record = part as Record<string, unknown>;
      if (!isPendingToolPart(record)) return part;

      // Prefer the row this message resolved to. If that row does not carry
      // this call, the result may have been persisted on a different row that
      // the client did not submit. Merge from it only when exactly one such
      // row holds the same call (toolCallId, tool and input); anything more
      // ambiguous leaves the part pending rather than risk attaching a result
      // to the wrong turn.
      const toolCallId = record.toolCallId as string;
      let server = ownResolvedParts?.get(toolCallId);
      const candidates = unclaimedResolvedByToolCallId.get(toolCallId);
      if (!server && candidates) {
        comparableParts ??= toolPartsByCallId(sanitize ? sanitize(msg) : msg);
        server = uniqueSameCall(
          candidates,
          comparableParts.get(toolCallId) ?? record
        );
      }

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

    const incomingToolParts = toolPartsByCallId(
      sanitize ? sanitize(incomingMessage) : incomingMessage
    );
    if (incomingToolParts.size > 0) {
      for (let i = 0; i < serverMessages.length; i++) {
        if (claimedServerIndices.has(i)) continue;

        const serverMessage = serverMessages[i];
        if (
          serverMessage.role === "assistant" &&
          carriesSameToolCalls(serverMessage, incomingToolParts)
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

/** The single candidate that is the same call as `record`, if exactly one. */
function uniqueSameCall(
  candidates: Record<string, unknown>[] | undefined,
  record: Record<string, unknown>
): Record<string, unknown> | undefined {
  const matches = candidates?.filter((candidate) =>
    sameToolCall(candidate, record)
  );
  return matches?.length === 1 ? matches[0] : undefined;
}

/**
 * Whether `serverMessage` shares at least one toolCallId with the incoming
 * message and every shared toolCallId is the same call on both sides. A
 * provider that reuses a toolCallId for a new call carries a different tool
 * or input, so it cannot adopt the older row's ID.
 */
function carriesSameToolCalls(
  serverMessage: UIMessage,
  incomingToolParts: Map<string, Record<string, unknown>>
): boolean {
  let shared = false;
  for (const part of serverMessage.parts) {
    const record = part as Record<string, unknown>;
    if (typeof record.toolCallId !== "string") continue;
    const incomingPart = incomingToolParts.get(record.toolCallId);
    if (!incomingPart) continue;
    if (!sameToolCall(record, incomingPart)) return false;
    shared = true;
  }
  return shared;
}

/**
 * Same tool and structurally equal input (object key order ignored). Static
 * tool parts may omit `toolName`, so it is compared only when both carry it.
 */
function sameToolCall(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): boolean {
  return (
    a.type === b.type &&
    (a.toolName === undefined ||
      b.toolName === undefined ||
      a.toolName === b.toolName) &&
    stableStringify(a.input) === stableStringify(b.input)
  );
}

function stableStringify(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item) ?? "null").join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function toolPartsByCallId(
  message: UIMessage
): Map<string, Record<string, unknown>> {
  const parts = new Map<string, Record<string, unknown>>();
  for (const part of message.parts) {
    const record = part as Record<string, unknown>;
    if (
      typeof record.toolCallId === "string" &&
      !parts.has(record.toolCallId)
    ) {
      parts.set(record.toolCallId, record);
    }
  }
  return parts;
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
