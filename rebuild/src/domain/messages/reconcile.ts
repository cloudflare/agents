import { isToolPart, type ChatMessage, type ToolPart } from "./model.js";

/**
 * Reconciliation of CLIENT-supplied message arrays against server history
 * (ISSUE-015). useChat-style clients round-trip their whole transcript on
 * every submit, so an incoming array can carry:
 *  - rows the server already owns (same id), possibly STALE — e.g. a tool
 *    part still `input-available` that the server has since settled;
 *  - optimistic assistant rows under CLIENT-generated ids duplicating a
 *    server-owned tool call (same toolCallId, different message id).
 * Persisting those blindly duplicates tool calls and downgrades settled
 * outputs. Spec source: the ported original suite
 * (test-workers/ported/message-reconciliation.test.ts).
 */
export interface ReconcilePlan {
  /** Genuinely-new messages, in incoming order. */
  toAppend: ChatMessage[];
  /** Known ids whose merged content differs from the stored row. */
  toUpdate: ChatMessage[];
}

const STATE_RANK: Record<ToolPart["state"], number> = {
  "input-streaming": 0,
  "input-available": 1,
  "approval-requested": 2,
  "output-available": 3,
  "output-error": 3,
};

function toolParts(message: ChatMessage): ToolPart[] {
  return message.parts.filter(isToolPart);
}

/** True when every tool call in `message` already lives on some OTHER history row. */
function duplicatesKnownToolCalls(message: ChatMessage, ownedToolCalls: Map<string, string>): boolean {
  const parts = toolParts(message);
  if (parts.length === 0) return false;
  return parts.every((part) => {
    const owner = ownedToolCalls.get(part.toolCallId);
    return owner !== undefined && owner !== message.id;
  });
}

/** Part-wise merge for a known id: never let a stale copy downgrade a settled tool part. */
function mergeKnown(existing: ChatMessage, incoming: ChatMessage): ChatMessage {
  const existingTools = new Map(toolParts(existing).map((part) => [part.toolCallId, part]));
  const parts = incoming.parts.map((part) => {
    if (!isToolPart(part)) return part;
    const stored = existingTools.get(part.toolCallId);
    if (stored && STATE_RANK[stored.state] > STATE_RANK[part.state]) return stored;
    return part;
  });
  // A stale snapshot may also have DROPPED settled parts (e.g. it predates
  // the output): if the incoming copy would lose any settled tool part,
  // keep the server row wholesale — position and content.
  const incomingIds = new Set(toolParts(incoming).map((part) => part.toolCallId));
  for (const [callId, stored] of existingTools) {
    if (!incomingIds.has(callId) && STATE_RANK[stored.state] >= STATE_RANK["output-available"]) {
      return existing;
    }
  }
  return { ...incoming, parts };
}

function sameMessage(a: ChatMessage, b: ChatMessage): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function reconcileIncoming(history: ChatMessage[], incoming: ChatMessage[]): ReconcilePlan {
  const byId = new Map(history.map((message) => [message.id, message]));
  const ownedToolCalls = new Map<string, string>();
  for (const message of history) {
    for (const part of toolParts(message)) ownedToolCalls.set(part.toolCallId, message.id);
  }

  const toAppend: ChatMessage[] = [];
  const toUpdate: ChatMessage[] = [];

  for (const message of incoming) {
    const existing = byId.get(message.id);
    if (existing) {
      const merged = mergeKnown(existing, message);
      if (!sameMessage(merged, existing)) toUpdate.push(merged);
      continue;
    }
    if (message.role === "assistant" && duplicatesKnownToolCalls(message, ownedToolCalls)) {
      // A client-side optimistic snapshot of a server-owned row: collapse it.
      continue;
    }
    toAppend.push(message);
    byId.set(message.id, message);
    for (const part of toolParts(message)) ownedToolCalls.set(part.toolCallId, message.id);
  }

  return { toAppend, toUpdate };
}
