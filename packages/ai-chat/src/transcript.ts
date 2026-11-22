/**
 * How `AIChatAgent` keeps its flat transcript in Sessions: the one-time
 * lift of the legacy table, hydration under a byte budget, the in-memory
 * mirror, what a persist writes, retention, and the `get-messages` body.
 */

import type { UIMessage } from "ai";
import { keepStoredReplies, reconcileMessages } from "agents/chat";
import type { Session, SessionMessage } from "agents/sessions";
import { autoTransformMessages } from "./ai-chat-v5-migration";

/** The table ai-chat stored messages in before Sessions. */
const LEGACY_TABLE = "cf_ai_chat_agent_messages";

/** Bounds for one window of the legacy lift: rows and their summed bytes. */
const LEGACY_LIFT_WINDOW_ROWS = 25;
const LEGACY_LIFT_WINDOW_BYTES = 4 * 1024 * 1024;

/**
 * Whether a parsed message has what the rest of the code relies on: a
 * non-empty string `id`, a known `role`, and a `parts` array (possibly
 * empty: the AI SDK requires parts on incoming messages, stored data is
 * read leniently). A message failing this would throw later, in
 * `convertToModelMessages` or the UI.
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
 * Lift ai-chat's legacy flat table into the default Sessions chain.
 *
 * Order is read first as ids alone, then message bodies are fetched in
 * windows bounded by row count and bytes, so a large transcript never sits
 * in the isolate at once. Once every row has a copy the legacy table is
 * dropped rather than renamed: keeping it would leave the object holding
 * its history twice. A row that cannot be parsed or imported leaves the
 * table in place, and the next start tries again (`importMessage` ignores
 * ids it already has).
 */
export async function liftLegacyMessages(
  sql: SqlStorage,
  session: Session
): Promise<void> {
  const present =
    sql
      .exec(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
        LEGACY_TABLE
      )
      .toArray().length > 0;
  if (!present) return;

  // Ids and sizes only: the ordering pass must not carry message bodies.
  const order = sql
    .exec<{ id: string; bytes: number; created_at: string | number | null }>(
      `SELECT id, LENGTH(CAST(message AS BLOB)) AS bytes, created_at
       FROM ${LEGACY_TABLE}
       ORDER BY created_at ASC, rowid ASC`
    )
    .toArray();

  let parentId: string | null = null;
  let imported = 0;
  let skipped = 0;
  let index = 0;
  while (index < order.length) {
    const window: typeof order = [];
    let bytes = 0;
    while (
      index < order.length &&
      window.length < LEGACY_LIFT_WINDOW_ROWS &&
      (window.length === 0 ||
        bytes + order[index].bytes <= LEGACY_LIFT_WINDOW_BYTES)
    ) {
      bytes += order[index].bytes;
      window.push(order[index]);
      index++;
    }
    const ids = JSON.stringify(window.map((row) => row.id));
    const bodies = new Map(
      sql
        .exec<{ id: string; message: string }>(
          `SELECT id, message FROM ${LEGACY_TABLE}
           WHERE id IN (SELECT value FROM json_each(?))`,
          ids
        )
        .toArray()
        .map((row) => [row.id, row.message] as const)
    );

    for (const row of window) {
      const body = bodies.get(row.id);
      if (body === undefined) {
        skipped++;
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(body);
        const message = autoTransformMessages([parsed])[0];
        if (!message || !isValidMessageStructure(message)) {
          console.warn(
            `[AIChatAgent] Skipping invalid legacy message ${row.id}: ` +
              "missing or malformed id, role, or parts"
          );
          skipped++;
          continue;
        }
        const parsedTime =
          typeof row.created_at === "number"
            ? row.created_at
            : Date.parse(String(row.created_at ?? ""));
        await session.importMessage(message, {
          parentId,
          createdAt: Number.isFinite(parsedTime) ? parsedTime : imported
        });
        parentId = message.id;
        imported++;
      } catch (error) {
        console.error(`Failed to migrate message ${row.id}:`, error);
        skipped++;
      }
    }
  }

  if (skipped === 0 && imported === order.length) {
    sql.exec(`DROP TABLE ${LEGACY_TABLE}`);
    return;
  }
  console.error(
    `[AIChatAgent] Legacy lift imported ${imported} of ${order.length} rows ` +
      `(${skipped} skipped); leaving ${LEGACY_TABLE} in place so ` +
      "they remain recoverable."
  );
}

/**
 * The messages to hold in memory after a wake: the recent history within
 * `budget` bytes (the whole history when the budget is not a positive
 * number). Rows without a valid structure are skipped with a warning.
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

/** What a turn's persist knows about the messages it was given. */
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
 */
export async function rowsPastRetention(
  session: Session,
  max: number
): Promise<string[]> {
  const stored = await session.getHistoryRowStats();
  const excess = stored.length - max;
  return excess > 0 ? stored.slice(0, excess).map((row) => row.id) : [];
}
