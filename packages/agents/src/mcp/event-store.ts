import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type {
  EventStore,
  EventId,
  StreamId
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/**
 * Durable Object–backed implementation of {@link EventStore}, used as the
 * default resumability store for `McpAgent`. Override
 * `McpAgent.getEventStore()` to swap or disable.
 *
 * Events are stored under keys of the form `__mcp_event__:<streamId>:<seqHex>`,
 * where `seqHex` is a fixed-width hexadecimal counter that preserves
 * lexicographic ordering. The generated `eventId` encodes both the stream
 * and the sequence (`<streamId>:<seqHex>`), so `getStreamIdForEventId` can
 * recover the stream without a storage lookup.
 *
 * Stored values are wrapped with a write timestamp:
 *
 *   `{ t: number; m: JSONRPCMessage }`
 *
 * so {@link sweep} can evict events older than a configured TTL even when
 * the owning POST stream never completes cleanly (e.g. the client just
 * disappeared). Without this, abandoned streams would accumulate events in
 * Durable Object storage indefinitely.
 *
 * The store is also bounded per stream by `maxEventsPerStream` (default
 * 256): when the bound is exceeded the oldest events for that stream are
 * evicted on each write. Streams that complete cleanly are dropped in full
 * via {@link clearStream}, called by the transport on the final response.
 *
 * Tied to the lifecycle of the owning Durable Object. When the DO is
 * destroyed, the event log is destroyed with it.
 */
export class DurableObjectEventStore implements EventStore {
  private static readonly KEY_PREFIX = "__mcp_event__:";
  private static readonly SEQ_PAD = 16; // 16-char hex = 64-bit counter

  private readonly storage: DurableObjectStorage;
  private readonly maxEventsPerStream: number;

  /** In-memory seq counters per stream, rehydrated lazily from storage. */
  private readonly seqByStream = new Map<StreamId, number>();
  private readonly seqInit = new Map<StreamId, Promise<void>>();

  constructor(
    storage: DurableObjectStorage,
    options: { maxEventsPerStream?: number } = {}
  ) {
    this.storage = storage;
    this.maxEventsPerStream = options.maxEventsPerStream ?? 256;
  }

  async storeEvent(
    streamId: StreamId,
    message: JSONRPCMessage
  ): Promise<EventId> {
    await this.ensureSeqLoaded(streamId);
    const seq = (this.seqByStream.get(streamId) ?? 0) + 1;
    this.seqByStream.set(streamId, seq);

    const seqHex = seq
      .toString(16)
      .padStart(DurableObjectEventStore.SEQ_PAD, "0");
    const eventId = `${streamId}:${seqHex}`;
    const key = `${DurableObjectEventStore.KEY_PREFIX}${eventId}`;

    const entry: StoredEntry = { t: Date.now(), m: message };
    await this.storage.put(key, entry);
    await this.evictOldEvents(streamId);

    return eventId;
  }

  async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    const idx = eventId.lastIndexOf(":");
    if (idx <= 0) return undefined;
    return eventId.slice(0, idx);
  }

  async replayEventsAfter(
    lastEventId: EventId,
    {
      send
    }: {
      send: (eventId: EventId, message: JSONRPCMessage) => Promise<void>;
    }
  ): Promise<StreamId> {
    const streamId = await this.getStreamIdForEventId(lastEventId);
    if (!streamId) return "";

    const prefix = `${DurableObjectEventStore.KEY_PREFIX}${streamId}:`;
    // `start: lastEventKey + "\x00"` would also work, but we filter explicitly
    // so the boundary is unambiguous if event IDs ever change format.
    const lastKey = `${DurableObjectEventStore.KEY_PREFIX}${lastEventId}`;
    const rows = await this.storage.list<StoredEntry>({
      prefix,
      start: lastKey,
      limit: this.maxEventsPerStream + 1
    });

    for (const [key, entry] of rows) {
      if (key <= lastKey) continue; // exclusive of lastEventId itself
      const eventId = key.slice(DurableObjectEventStore.KEY_PREFIX.length);
      await send(eventId, entry.m);
    }

    return streamId;
  }

  /**
   * Drop the event log for a given stream. The transport calls this when a
   * POST stream has been fully responded to. Optional but recommended; the
   * events also disappear when the DO is destroyed.
   */
  async clearStream(streamId: StreamId): Promise<void> {
    const prefix = `${DurableObjectEventStore.KEY_PREFIX}${streamId}:`;
    const rows = await this.storage.list({ prefix });
    if (rows.size === 0) return;
    await this.storage.delete([...rows.keys()]);
    this.seqByStream.delete(streamId);
    this.seqInit.delete(streamId);
  }

  /**
   * Evict every stored event older than `maxAgeMs` milliseconds.
   *
   * Used to bound storage growth from POST streams that never complete
   * cleanly (e.g. client disconnects and never reconnects to consume the
   * final response). Bounded per call by `batchSize` so a single sweep
   * doesn't block the DO for too long.
   *
   * Returns the number of events deleted.
   */
  async sweep(
    maxAgeMs: number,
    { batchSize = 512 }: { batchSize?: number } = {}
  ): Promise<number> {
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return 0;
    const cutoff = Date.now() - maxAgeMs;
    const rows = await this.storage.list<StoredEntry>({
      prefix: DurableObjectEventStore.KEY_PREFIX,
      limit: batchSize
    });

    const expired: string[] = [];
    const expiredStreams = new Set<StreamId>();
    for (const [key, entry] of rows) {
      // Tolerate legacy un-wrapped values: treat as expired so they don't
      // linger forever. Should only matter during a one-time migration.
      const ts =
        entry && typeof entry === "object" && "t" in entry ? entry.t : 0;
      if (ts < cutoff) {
        expired.push(key);
        // Extract streamId so we can drop in-memory seq state if the whole
        // stream was wiped.
        const eventId = key.slice(DurableObjectEventStore.KEY_PREFIX.length);
        const idx = eventId.lastIndexOf(":");
        if (idx > 0) expiredStreams.add(eventId.slice(0, idx));
      }
    }

    if (expired.length === 0) return 0;
    await this.storage.delete(expired);

    // For each stream we touched, if no rows remain, drop the in-memory
    // seq counter so it gets rehydrated fresh on the next storeEvent.
    for (const streamId of expiredStreams) {
      const remaining = await this.storage.list({
        prefix: `${DurableObjectEventStore.KEY_PREFIX}${streamId}:`,
        limit: 1
      });
      if (remaining.size === 0) {
        this.seqByStream.delete(streamId);
        this.seqInit.delete(streamId);
      }
    }

    return expired.length;
  }

  /**
   * Rehydrate the in-memory seq counter from storage. The counter only
   * lives in memory, so after DO hibernation we recover it by reading the
   * latest stored eventId for the stream. Concurrent callers share a
   * single load.
   */
  private async ensureSeqLoaded(streamId: StreamId): Promise<void> {
    if (this.seqByStream.has(streamId)) return;
    let pending = this.seqInit.get(streamId);
    if (!pending) {
      pending = (async () => {
        const prefix = `${DurableObjectEventStore.KEY_PREFIX}${streamId}:`;
        const rows = await this.storage.list({
          prefix,
          reverse: true,
          limit: 1
        });
        let seq = 0;
        for (const key of rows.keys()) {
          const hex = key.slice(prefix.length);
          const parsed = Number.parseInt(hex, 16);
          if (Number.isFinite(parsed)) seq = parsed;
        }
        if (!this.seqByStream.has(streamId)) {
          this.seqByStream.set(streamId, seq);
        }
      })();
      this.seqInit.set(streamId, pending);
    }
    try {
      await pending;
    } finally {
      this.seqInit.delete(streamId);
    }
  }

  private async evictOldEvents(streamId: StreamId): Promise<void> {
    const prefix = `${DurableObjectEventStore.KEY_PREFIX}${streamId}:`;
    // `list` is bounded so this scan stays cheap; we only need the oldest keys
    // when we're over the budget.
    const rows = await this.storage.list({
      prefix,
      limit: this.maxEventsPerStream + 16
    });
    const excess = rows.size - this.maxEventsPerStream;
    if (excess <= 0) return;
    const toDelete: string[] = [];
    let i = 0;
    for (const key of rows.keys()) {
      if (i++ >= excess) break;
      toDelete.push(key);
    }
    if (toDelete.length > 0) await this.storage.delete(toDelete);
  }
}

/** Wire format for {@link DurableObjectEventStore} entries. */
type StoredEntry = {
  /** `Date.now()` at write time. Used by {@link DurableObjectEventStore.sweep}. */
  t: number;
  /** The original JSON-RPC message. */
  m: JSONRPCMessage;
};
