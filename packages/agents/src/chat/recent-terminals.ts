/**
 * The terminal frames of the last few requests, so a tab that was away when
 * its request ended learns the outcome when it comes back.
 *
 * A request can end while no tab is connected: a request replayed from its
 * admission record after a reset, which ends superseded, merged or skipped
 * before any tab reconnected, or a turn that ends while every tab is
 * reconnecting. Its terminal frame went to nobody. The resume request names
 * the request ids a tab still waits on, and the handshake replays the
 * recorded frame of one that ended (`ResumeHandshake`).
 *
 * The record is bounded: the last {@link RECENT_TERMINALS_MAX} requests.
 * A tab waits on at most a request or two, and a tab that was away longer
 * than that many requests gets the transcript instead.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API.
 */

/** Durable Object storage key of the record. */
export const RECENT_TERMINALS_KEY = "cf:chat-recent-terminals";

/** How many requests the record keeps. */
export const RECENT_TERMINALS_MAX = 16;

/** One request's terminal frame, as it was sent. */
export interface ChatRecentTerminal {
  requestId: string;
  body: string;
  error?: boolean;
  outcome?: string;
  continuation?: boolean;
  messageIds?: string[];
}

/** The synchronous key-value storage of a SQLite-backed Durable Object. */
export interface RecentTerminalsKv {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
}

function read(kv: RecentTerminalsKv): ChatRecentTerminal[] {
  const stored = kv.get<ChatRecentTerminal[]>(RECENT_TERMINALS_KEY);
  return Array.isArray(stored) ? stored : [];
}

/**
 * Record a terminal frame (`done` or `error`) of a chat response. Frames of
 * other kinds are ignored. A request's newer terminal replaces its older one.
 */
export function recordRecentChatTerminal(
  kv: RecentTerminalsKv,
  frame: {
    id?: unknown;
    done?: unknown;
    error?: unknown;
    body?: unknown;
    outcome?: unknown;
    continuation?: unknown;
    messageIds?: unknown;
  }
): void {
  if (typeof frame.id !== "string") return;
  if (frame.done !== true && frame.error !== true) return;
  const entry: ChatRecentTerminal = {
    requestId: frame.id,
    body: typeof frame.body === "string" ? frame.body : "",
    ...(frame.error === true && { error: true }),
    ...(typeof frame.outcome === "string" && { outcome: frame.outcome }),
    ...(frame.continuation === true && { continuation: true }),
    ...(Array.isArray(frame.messageIds) && {
      messageIds: frame.messageIds.filter(
        (id): id is string => typeof id === "string"
      )
    })
  };
  const kept = read(kv).filter((stored) => stored.requestId !== frame.id);
  kept.push(entry);
  kv.put(RECENT_TERMINALS_KEY, kept.slice(-RECENT_TERMINALS_MAX));
}

/**
 * The newest recorded terminal of one of `requestIds`, or `null` when none of
 * them ended in the window the record keeps.
 */
export function recentChatTerminal(
  kv: RecentTerminalsKv,
  requestIds: readonly string[]
): ChatRecentTerminal | null {
  if (requestIds.length === 0) return null;
  const records = read(kv);
  for (let i = records.length - 1; i >= 0; i--) {
    if (requestIds.includes(records[i].requestId)) return records[i];
  }
  return null;
}

/** Forget every record (a chat clear). */
export function clearRecentChatTerminals(kv: RecentTerminalsKv): void {
  kv.put(RECENT_TERMINALS_KEY, []);
}
