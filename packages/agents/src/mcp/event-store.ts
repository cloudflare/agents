import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type {
  EventStore,
  EventId,
  StreamId
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/**
 * Durable Object–backed implementation of {@link EventStore}.
 *
 * Events are stored under keys of the form `__mcp_event__:<streamId>:<seqHex>`,
 * where `seqHex` is a fixed-width hexadecimal counter that preserves
 * lexicographic ordering. The generated `eventId` encodes both the stream and
 * the sequence (`<streamId>:<seqHex>`), so `getStreamIdForEventId` can recover
 * the stream without a storage lookup.
 *
 * The store is bounded per stream by `maxEventsPerStream` (default 256). When
 * the bound is exceeded the oldest events for that stream are evicted.
 *
 * This default implementation supports SSE resumption via `Last-Event-ID`,
 * which lets clients reconnect after the Cloudflare edge closes an idle stream
 * (~5 minute watchdog) instead of relying on a server-side keepalive that
 * would prevent the Durable Object from hibernating.
 *
 * @remarks
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

    await this.storage.put(key, message);
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
    const rows = await this.storage.list<JSONRPCMessage>({
      prefix,
      start: lastKey,
      limit: this.maxEventsPerStream + 1
    });

    for (const [key, message] of rows) {
      if (key <= lastKey) continue; // exclusive of lastEventId itself
      const eventId = key.slice(DurableObjectEventStore.KEY_PREFIX.length);
      await send(eventId, message);
    }

    return streamId;
  }

  /**
   * Drop the event log for a given stream. Call this when a session is closed
   * to reclaim storage. Optional; the events also disappear when the DO is
   * destroyed.
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
   * Rehydrate the in-memory seq counter from storage. The counter only lives
   * in memory, so after DO hibernation we recover it by reading the latest
   * stored eventId for the stream. Concurrent callers share a single load.
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
