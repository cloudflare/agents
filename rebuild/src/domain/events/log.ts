import type { Clock } from "../../ports/clock.js";
import type { KeyValueStore } from "../../ports/storage.js";
import type { ChatMessage } from "../messages/model.js";
import type { UiChunk } from "../stream/chunks.js";

/**
 * ConversationEventLog (audit 25 §1): the agent's single outbound port. The
 * agent publishes typed ConversationEvents here; adapters subscribe (from an
 * offset, or "live") and translate events into whatever their surface speaks
 * (WS frames, parent RPC, ...). The log is durable, offset-addressed, and
 * absorbed the retention role formerly played by `domain/stream/resumable.ts`
 * (deleted in wave R3 once the WS adapter landed on this log instead): a
 * turn's `chunk` events are the durable trace a reconnecting client replays
 * from.
 */

export type ConversationEvent =
  | { type: "turn:started"; requestId: string; trigger: string; channelId?: string }
  | { type: "chunk"; requestId: string; chunk: UiChunk }
  | { type: "message:updated"; message: ChatMessage; requestId?: string }
  | { type: "conversation:cleared" }
  | {
      type: "state:changed";
      state: unknown;
      origin: { kind: "server" } | { kind: "client"; sourceId: string };
    }
  | { type: "recovering:changed"; active: boolean; requestId?: string }
  | { type: "session:status"; phase: "idle" | "compacting"; tokenEstimate: number; tokenThreshold?: number }
  | { type: "run:event"; runId: string; event: unknown }
  | {
      type: "turn:settled";
      requestId: string;
      outcome: "completed" | "suspended" | "cancelled" | "failed";
      suspendedOn?: "client-tool" | "approval" | "durable-pause";
      errorText?: string;
    };

export interface StoredEvent {
  offset: number;
  at: number;
  event: ConversationEvent;
}

export type CatchUp =
  | { kind: "events"; events: StoredEvent[] }
  | { kind: "gap"; firstAvailable: number };

export interface ConversationEventLog {
  /** Assigns the next offset, persists, and notifies live subscribers. */
  publish(event: ConversationEvent): StoredEvent;
  /** Next offset to be assigned (== the count of ever-published events). */
  head(): number;
  read(fromOffset: number, limit?: number): CatchUp;
  /**
   * Replays [fromOffset, head) synchronously via fn (replay=true for each),
   * then continues delivering live events (replay=false). fromOffset "live"
   * skips catch-up entirely. Returns an unsubscribe function.
   */
  subscribe(fromOffset: number | "live", fn: (e: StoredEvent, replay: boolean) => void): () => void;
  /** Prune per retention policy; returns the number of events pruned. */
  gc(): number;
}

const DEFAULT_SETTLED_TURN_CHUNKS_MS = 600_000; // 10 minutes
const DEFAULT_ABANDONED_TURN_CHUNKS_MS = 3_600_000; // 1 hour
const DEFAULT_MAX_LIGHT_EVENTS = 500;

/** Fixed-width zero-padding so lexicographic key order == numeric offset order. */
const OFFSET_WIDTH = 15;

const EVENT_PREFIX = "evt:";
const TURN_META_PREFIX = "turn:";
const HEAD_KEY = "head";

/** Per-turn bookkeeping the log derives from chunk/turn:settled events themselves. */
interface TurnMeta {
  /** Time of the most recent chunk event for this turn (drives abandonment aging). */
  lastChunkAt: number;
  /** Set once a turn:settled event for this turn has been published. */
  settledAt?: number;
}

export function createConversationEventLog(deps: {
  /** Already scoped to this module's own prefix by the caller (e.g. "evlog:"). */
  store: KeyValueStore;
  clock: Clock;
  retention?: {
    settledTurnChunksMs?: number;
    abandonedTurnChunksMs?: number;
    maxLightEvents?: number;
  };
}): ConversationEventLog {
  const { store, clock } = deps;
  const settledTurnChunksMs = deps.retention?.settledTurnChunksMs ?? DEFAULT_SETTLED_TURN_CHUNKS_MS;
  const abandonedTurnChunksMs = deps.retention?.abandonedTurnChunksMs ?? DEFAULT_ABANDONED_TURN_CHUNKS_MS;
  const maxLightEvents = deps.retention?.maxLightEvents ?? DEFAULT_MAX_LIGHT_EVENTS;

  const subscribers = new Set<(e: StoredEvent, replay: boolean) => void>();

  function padOffset(offset: number): string {
    return String(offset).padStart(OFFSET_WIDTH, "0");
  }

  function eventKey(offset: number): string {
    return `${EVENT_PREFIX}${padOffset(offset)}`;
  }

  function turnMetaKey(requestId: string): string {
    return `${TURN_META_PREFIX}${requestId}`;
  }

  function getHead(): number {
    return store.get<number>(HEAD_KEY) ?? 0;
  }

  function setHead(next: number): void {
    store.put(HEAD_KEY, next);
  }

  function getTurnMeta(requestId: string): TurnMeta | undefined {
    return store.get<TurnMeta>(turnMetaKey(requestId));
  }

  /** All currently-stored events, in ascending offset order. */
  function allEvents(): StoredEvent[] {
    return [...store.list<StoredEvent>({ prefix: EVENT_PREFIX }).values()];
  }

  function notify(stored: StoredEvent, replay: boolean): void {
    for (const fn of [...subscribers]) {
      try {
        fn(stored, replay);
      } catch {
        // A subscriber's failure must not break delivery to other subscribers
        // (mirrors kernel/events.ts's bus rule).
      }
    }
  }

  function publish(event: ConversationEvent): StoredEvent {
    const offset = getHead();
    const at = clock.now();
    const stored: StoredEvent = { offset, at, event };
    store.put(eventKey(offset), stored);
    setHead(offset + 1);

    if (event.type === "chunk") {
      const meta = getTurnMeta(event.requestId);
      store.put(turnMetaKey(event.requestId), { ...meta, lastChunkAt: at });
    } else if (event.type === "turn:settled") {
      const meta = getTurnMeta(event.requestId);
      store.put(turnMetaKey(event.requestId), { lastChunkAt: at, ...meta, settledAt: at });
    }

    notify(stored, false);
    return stored;
  }

  function head(): number {
    return getHead();
  }

  /** Smallest offset still present in the store, or head() if nothing survives. */
  function lowestAvailableOffset(): number {
    const all = allEvents();
    return all.length > 0 ? all[0]!.offset : getHead();
  }

  function read(fromOffset: number, limit?: number): CatchUp {
    const currentHead = getHead();
    if (fromOffset >= currentHead) {
      return { kind: "events", events: [] };
    }
    const firstAvailable = lowestAvailableOffset();
    if (fromOffset < firstAvailable) {
      return { kind: "gap", firstAvailable };
    }
    const events = allEvents().filter((e) => e.offset >= fromOffset);
    return { kind: "events", events: limit !== undefined ? events.slice(0, limit) : events };
  }

  function subscribe(fromOffset: number | "live", fn: (e: StoredEvent, replay: boolean) => void): () => void {
    if (fromOffset !== "live") {
      for (const stored of allEvents()) {
        if (stored.offset < fromOffset) continue;
        try {
          fn(stored, true);
        } catch {
          // isolate: same rule as notify().
        }
      }
    }
    subscribers.add(fn);
    return () => {
      subscribers.delete(fn);
    };
  }

  function gc(): number {
    const now = clock.now();
    const all = allEvents();
    let pruned = 0;
    const prunedOffsets = new Set<number>();
    const turnsSeen = new Set<string>();

    for (const stored of all) {
      if (stored.event.type !== "chunk") continue;
      const requestId = stored.event.requestId;
      turnsSeen.add(requestId);
      const meta = getTurnMeta(requestId);
      if (!meta) continue;
      const stale =
        meta.settledAt !== undefined
          ? now - meta.settledAt >= settledTurnChunksMs
          : now - meta.lastChunkAt >= abandonedTurnChunksMs;
      if (stale) {
        store.delete(eventKey(stored.offset));
        prunedOffsets.add(stored.offset);
        pruned++;
      }
    }

    for (const requestId of turnsSeen) {
      const stillHasChunks = all.some(
        (e) => e.event.type === "chunk" && e.event.requestId === requestId && !prunedOffsets.has(e.offset),
      );
      if (!stillHasChunks) store.delete(turnMetaKey(requestId));
    }

    const lightEvents = all.filter((e) => e.event.type !== "chunk").sort((a, b) => a.offset - b.offset);
    if (lightEvents.length > maxLightEvents) {
      const excess = lightEvents.length - maxLightEvents;
      for (let i = 0; i < excess; i++) {
        store.delete(eventKey(lightEvents[i]!.offset));
        pruned++;
      }
    }

    return pruned;
  }

  return { publish, head, read, subscribe, gc };
}
