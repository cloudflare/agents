import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type {
  EventStore,
  EventId,
  StreamId
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/**
 * Durable Object–backed {@link EventStore} for SSE resumability.
 *
 * Default for `McpAgent`. Override `McpAgent.getEventStore()` to swap
 * or disable.
 *
 * ## Storage layout
 *
 * - `__mcp_event__:<streamId>:<seqHex>` — the JSON-RPC message.
 *   `<seqHex>` is a 16-char zero-padded counter, so events in a stream
 *   sort lexicographically and `getStreamIdForEventId` can recover the
 *   stream from `eventId` without a storage hit.
 * - `__mcp_stream_evt_meta__:<streamId>` — `{ lastWriteAt }`, updated on
 *   every `storeEvent`. The cleanup sweep scans only this index, never
 *   the event log itself, so cleanup cost is O(active streams) not
 *   O(total events).
 *
 * Storage is bounded by the cleanup alarm `McpAgent` schedules off the
 * `onStoreEvent` hook: when streams have been quiet for `maxAgeMs`,
 * {@link sweep} drops every event of those streams. The DO itself dies
 * with the session.
 */
export class DurableObjectEventStore implements EventStore {
  private static readonly EVENT_KEY_PREFIX = "__mcp_event__:";
  private static readonly META_KEY_PREFIX = "__mcp_stream_evt_meta__:";
  private static readonly SEQ_PAD = 16;

  private readonly storage: DurableObjectStorage;
  private readonly onStoreEvent?: () => void | Promise<void>;

  /** In-memory seq counters per stream, rehydrated lazily from storage. */
  private readonly seqByStream = new Map<StreamId, number>();
  private readonly seqInit = new Map<StreamId, Promise<void>>();

  constructor(
    storage: DurableObjectStorage,
    options: {
      /** Fired after each successful `storeEvent`. McpAgent uses this
       *  to arm a cleanup alarm. */
      onStoreEvent?: () => void | Promise<void>;
    } = {}
  ) {
    this.storage = storage;
    this.onStoreEvent = options.onStoreEvent;
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
    const eventKey = `${DurableObjectEventStore.EVENT_KEY_PREFIX}${eventId}`;
    const metaKey = `${DurableObjectEventStore.META_KEY_PREFIX}${streamId}`;

    const meta: StreamMeta = { lastWriteAt: Date.now() };
    await this.storage.put({ [eventKey]: message, [metaKey]: meta });

    if (this.onStoreEvent) await this.onStoreEvent();
    return eventId;
  }

  async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    const idx = eventId.lastIndexOf(":");
    return idx > 0 ? eventId.slice(0, idx) : undefined;
  }

  async replayEventsAfter(
    lastEventId: EventId,
    {
      send
    }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> }
  ): Promise<StreamId> {
    const streamId = await this.getStreamIdForEventId(lastEventId);
    if (!streamId) return "";

    const prefix = `${DurableObjectEventStore.EVENT_KEY_PREFIX}${streamId}:`;
    const lastKey = `${DurableObjectEventStore.EVENT_KEY_PREFIX}${lastEventId}`;
    // No explicit limit — DO storage list defaults to 1000 which is a
    // safe upper bound for a single replay batch. Clients can issue
    // further reconnects to drain longer histories.
    const rows = await this.storage.list<JSONRPCMessage>({
      prefix,
      start: lastKey
    });

    for (const [key, message] of rows) {
      if (key <= lastKey) continue;
      const eventId = key.slice(
        DurableObjectEventStore.EVENT_KEY_PREFIX.length
      );
      await send(eventId, message);
    }
    return streamId;
  }

  /** Drop the event log for a single stream. */
  async clearStream(streamId: StreamId): Promise<void> {
    const prefix = `${DurableObjectEventStore.EVENT_KEY_PREFIX}${streamId}:`;
    const rows = await this.storage.list({ prefix });
    const keys = [...rows.keys()];
    keys.push(`${DurableObjectEventStore.META_KEY_PREFIX}${streamId}`);
    await this.storage.delete(keys);
    this.seqByStream.delete(streamId);
    this.seqInit.delete(streamId);
  }

  /**
   * Delete every event of every stream whose `lastWriteAt` is older
   * than `cutoff`. Returns the streamIds it deleted (so callers can
   * clean up sibling state like routing entries) and the next-earliest
   * `lastWriteAt` still present (so the agent can schedule its next
   * alarm), or `undefined` if the store is empty.
   */
  async sweep(cutoff: number): Promise<{
    expiredStreamIds: StreamId[];
    nextWriteAt: number | undefined;
  }> {
    const rows = await this.storage.list<StreamMeta>({
      prefix: DurableObjectEventStore.META_KEY_PREFIX
    });

    const expired: StreamId[] = [];
    let nextWriteAt: number | undefined;
    for (const [key, meta] of rows) {
      const ts = meta?.lastWriteAt ?? 0;
      const streamId = key.slice(
        DurableObjectEventStore.META_KEY_PREFIX.length
      );
      if (ts < cutoff) {
        expired.push(streamId);
      } else if (nextWriteAt === undefined || ts < nextWriteAt) {
        nextWriteAt = ts;
      }
    }

    if (expired.length === 0) {
      return { expiredStreamIds: [], nextWriteAt };
    }

    const toDelete: string[] = [];
    for (const streamId of expired) {
      const eventPrefix = `${DurableObjectEventStore.EVENT_KEY_PREFIX}${streamId}:`;
      const eventRows = await this.storage.list({ prefix: eventPrefix });
      for (const k of eventRows.keys()) toDelete.push(k);
      toDelete.push(`${DurableObjectEventStore.META_KEY_PREFIX}${streamId}`);
      this.seqByStream.delete(streamId);
      this.seqInit.delete(streamId);
    }
    await this.storage.delete(toDelete);

    return { expiredStreamIds: expired, nextWriteAt };
  }

  private async ensureSeqLoaded(streamId: StreamId): Promise<void> {
    if (this.seqByStream.has(streamId)) return;
    let pending = this.seqInit.get(streamId);
    if (!pending) {
      pending = (async () => {
        const prefix = `${DurableObjectEventStore.EVENT_KEY_PREFIX}${streamId}:`;
        const rows = await this.storage.list({
          prefix,
          reverse: true,
          limit: 1
        });
        let seq = 0;
        for (const key of rows.keys()) {
          const parsed = Number.parseInt(key.slice(prefix.length), 16);
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
}

type StreamMeta = { lastWriteAt: number };
