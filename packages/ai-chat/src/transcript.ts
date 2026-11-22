/**
 * How `AIChatAgent` keeps its flat transcript in Sessions: how a row of
 * the legacy table is read for the Sessions lift, hydration under a byte
 * budget, the in-memory mirror, what a persist writes, retention, and the
 * `get-messages` body.
 */

import type { UIMessage } from "ai";
import { keepStoredReplies, reconcileMessages } from "agents/chat";
import type { Session, SessionMessage } from "agents/sessions";
import { autoTransformMessages } from "./ai-chat-v5-migration";

/** The table ai-chat stored messages in before Sessions. */
export const LEGACY_MESSAGES_TABLE = "cf_ai_chat_agent_messages";

/**
 * Whether a parsed message has what the rest of the code relies on: a
 * non-empty string `id`, a known `role`, and a `parts` array (possibly
 * empty: the AI SDK requires parts on incoming messages, stored data is
 * read leniently). A message failing this would throw later, in
 * `convertToModelMessages` or the UI.
 *
 * @internal
 */
export function isValidMessageStructure(msg: unknown): msg is UIMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (typeof m.id !== "string" || m.id.length === 0) return false;
  if (m.role !== "user" && m.role !== "assistant" && m.role !== "system") {
    return false;
  }
  return Array.isArray(m.parts);
}

/**
 * A row of the legacy table as a message, for the Sessions lift: shapes
 * from older AI SDK versions are converted, and a row without a valid
 * structure is skipped with a warning (it keeps the table for a retry).
 *
 * @internal
 */
export function parseLegacyMessage(
  raw: unknown,
  id: string
): UIMessage | undefined {
  const message = autoTransformMessages([raw])[0];
  if (!message || !isValidMessageStructure(message)) {
    console.warn(
      `[AIChatAgent] Skipping invalid legacy message ${id}: ` +
        "missing or malformed id, role, or parts"
    );
    return undefined;
  }
  return message;
}

/**
 * The messages to hold in memory after a wake: the recent history within
 * `budget` bytes (the whole history when the budget is not a positive
 * number). Rows without a valid structure are skipped with a warning.
 *
 * @internal
 */
export async function hydrateMessages(
  session: Session,
  budget: number
): Promise<UIMessage[]> {
  const stored =
    Number.isFinite(budget) && budget > 0
      ? (await session.getRecentHistory(budget)).messages
      : await session.getHistory();

  const messages: UIMessage[] = [];
  for (const message of stored as unknown[]) {
    if (!isValidMessageStructure(message)) {
      console.warn(
        `[AIChatAgent] Skipping invalid message ${(message as { id?: unknown } | null)?.id}: ` +
          "missing or malformed id, role, or parts"
      );
      continue;
    }
    messages.push(message);
  }
  return autoTransformMessages(messages);
}

/**
 * The whole transcript as a JSON array of messages, without ever holding
 * it in one string: `historyBatches()` yields bounded batches and each
 * batch is encoded straight into the body.
 *
 * @internal
 */
export function transcriptJson(session: Session): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const batches = session.historyBatches();
  let opened = false;
  let first = true;
  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      if (!opened) {
        opened = true;
        controller.enqueue(encoder.encode("["));
        return;
      }
      const next = await batches.next();
      if (next.done) {
        controller.enqueue(encoder.encode("]"));
        controller.close();
        return;
      }
      let chunk = "";
      for (const message of autoTransformMessages(next.value as UIMessage[])) {
        chunk += `${first ? "" : ","}${JSON.stringify(message)}`;
        first = false;
      }
      if (chunk.length > 0) controller.enqueue(encoder.encode(chunk));
    },
    cancel: async () => {
      await batches.return?.(undefined);
    }
  });
}

/**
 * Keep `messages` in step with the Sessions change feed. Every durable
 * write dispatches here synchronously, so write sites never patch the
 * array by hand. A stored row is exactly what the write returned, so
 * turning it into its in-memory form never costs a re-read.
 *
 * @internal
 */
export function mirrorTranscript(
  session: Session,
  get: () => UIMessage[],
  set: (messages: UIMessage[]) => void
): void {
  session.mirror<UIMessage>({
    get,
    set,
    transform: (message: SessionMessage) => {
      const stored = message as UIMessage;
      return autoTransformMessages([stored])[0] ?? stored;
    }
  });
}

/**
 * What a turn's persist knows about the messages it was given.
 *
 * @internal
 */
export interface PersistScope {
  /** The messages are a client's copy (`keepStoredReplies`). */
  clientCopy: boolean;
  /** Messages a waiting request holds: never stored or broadcast. */
  hold?: ReadonlySet<string>;
}

/**
 * What `persistMessages` stores, given the messages it was called with and
 * the transcript before the write.
 *
 * `merged` is the transcript after the write: the incoming messages
 * reconciled against the stored ones (server tool results and ids win),
 * a client's copy never shortening a stored reply, held messages left
 * out. `toWrite` is the part of it that differs from what is stored,
 * sanitized. A message serializing to what is stored already is skipped
 * here with a string compare; letting Sessions find out would cost a row
 * read and, for media, a decode and hash of every payload on every turn.
 *
 * @internal
 */
export function planPersist(
  messages: UIMessage[],
  prior: readonly UIMessage[],
  sanitize: (message: UIMessage) => UIMessage,
  scope?: PersistScope
): { merged: UIMessage[]; toWrite: UIMessage[] } {
  const priorList = [...prior];
  const priorById = new Map(priorList.map((m) => [m.id, m]));
  const reconciled = reconcileMessages(messages, priorList, sanitize);
  const kept = scope?.clientCopy
    ? keepStoredReplies(reconciled, priorList)
    : reconciled;
  const hold = scope?.hold;
  const merged =
    hold && hold.size > 0 ? kept.filter((m) => !hold.has(m.id)) : kept;

  const toWrite: UIMessage[] = [];
  for (const message of merged) {
    const resolved = sanitize(message);
    const stored = priorById.get(resolved.id);
    if (stored && JSON.stringify(stored) === JSON.stringify(resolved)) continue;
    toWrite.push(resolved);
  }
  return { merged, toWrite };
}

/**
 * The ids to delete after a regenerate. A regenerate can submit a strict
 * subset of the stored transcript; when every merged message was stored
 * before, the stored messages it left out go. Sessions splices their
 * descendants to the grandparent, so the active path stays whole.
 *
 * @internal
 */
export function staleMessageIds(
  merged: readonly UIMessage[],
  prior: readonly UIMessage[],
  current: readonly UIMessage[]
): string[] {
  const priorIds = new Set(prior.map((message) => message.id));
  if (!merged.every((message) => priorIds.has(message.id))) return [];
  const keep = new Set(merged.map((message) => message.id));
  return current.map((message) => message.id).filter((id) => !keep.has(id));
}

/**
 * The oldest stored rows past `max`. Counts stored rows, not the hydrated
 * window: a transcript larger than the hydration budget holds rows the
 * in-memory list never saw.
 *
 * @internal
 */
export async function rowsPastRetention(
  session: Session,
  max: number
): Promise<string[]> {
  const stored = await session.getHistoryRowStats();
  const excess = stored.length - max;
  return excess > 0 ? stored.slice(0, excess).map((row) => row.id) : [];
}
