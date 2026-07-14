import type { KeyValueStore } from "../../ports/storage.js";
import { repairTranscript } from "../messages/repair.js";
import type { ChatMessage, MessagePart, ToolPart } from "../messages/model.js";
import type { Session } from "../session/session.js";

/**
 * ConversationTurnState (audit 26 extraction 1): the small durable bookkeeping
 * Think needs across the lifetime of a turn — the last-emitted partial
 * assistant message per requestId, the last requestId itself (recovery keys
 * off it), and which channel a given requestId ran on. Each key lives under
 * the caller-scoped store prefix, per the "each module owns its prefix" rule.
 */
export interface ConversationTurnState {
  recordPartial(requestId: string, message: ChatMessage): void;
  partialFor(requestId: string): ChatMessage | undefined;
  clearPartial(requestId: string): void;
  lastRequestId(): string | undefined;
  /** `undefined` clears the last-request bookkeeping (e.g. clearMessages()). */
  setLastRequestId(id: string | undefined): void;
  channelFor(requestId: string): string | undefined;
  stampChannel(requestId: string, channelId: string): void;
  /**
   * Repair the recorded partial (repairTranscript on the single message) and
   * append it to the session; clears the partial. No-op without a partial,
   * and no-op if the partial's id is already part of session history (a
   * normal suspension already committed it — appending again under the same
   * id would corrupt the message tree).
   */
  commitInterruptedPartial(
    requestId: string,
    session: Session,
    repairPart?: (part: ToolPart) => MessagePart,
  ): Promise<ChatMessage | undefined>;
}

const LAST_REQUEST_KEY = "lastRequestId";

function partialKey(requestId: string): string {
  return `partial:${requestId}`;
}

function channelKey(requestId: string): string {
  return `channel:${requestId}`;
}

export function createConversationTurnState(deps: { store: KeyValueStore }): ConversationTurnState {
  const { store } = deps;

  return {
    recordPartial(requestId, message) {
      store.put(partialKey(requestId), message);
    },

    partialFor(requestId) {
      return store.get<ChatMessage>(partialKey(requestId));
    },

    clearPartial(requestId) {
      store.delete(partialKey(requestId));
    },

    lastRequestId() {
      return store.get<string>(LAST_REQUEST_KEY);
    },

    setLastRequestId(id) {
      if (id === undefined) store.delete(LAST_REQUEST_KEY);
      else store.put(LAST_REQUEST_KEY, id);
    },

    channelFor(requestId) {
      return store.get<string>(channelKey(requestId));
    },

    stampChannel(requestId, channelId) {
      store.put(channelKey(requestId), channelId);
    },

    async commitInterruptedPartial(requestId, session, repairPart) {
      const partial = store.get<ChatMessage>(partialKey(requestId));
      if (!partial || partial.parts.length === 0) return undefined;

      const history = await session.getHistory();
      if (history.some((m) => m.id === partial.id)) return undefined; // already committed

      const repairOpts = repairPart ? { repairPart } : undefined;
      const [repaired] = repairTranscript([partial], repairOpts).messages;
      await session.appendMessage(repaired!);
      store.delete(partialKey(requestId));
      return repaired;
    },
  };
}
