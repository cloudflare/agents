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
 * Events are stored under `__mcp_event__:<streamId>:<seqHex>`, where
 * `<seqHex>` is a 16-char zero-padded counter so events in a stream
 * sort lexicographically and `getStreamIdForEventId` can recover the
 * stream from `eventId` without a storage hit.
 *
 * ## Lifecycle
 *
 * Each POST tool-call stream's events live only until the final
 * response is delivered. The transport calls {@link clearStream}
 * immediately after writing the close frame, so storage growth is
 * bounded by the in-flight POST streams plus the standalone GET
 * stream. There is no background sweep — quiescent agents do no work,
 * and the DO itself dies with the session.
 *
 * Standalone GET stream events (`_GET_stream`) are *not* cleared
 * automatically; they accumulate for the lifetime of the DO. Bounded
 * by session length in practice.
 *
 * Trade-off: if the client TCP connection dies *after* the close
 * frame has been enqueued on the WS but before the bytes reach the
 * client, the final message is unreplayable. Every earlier event in
 * the stream is still replayable while the in-flight stream is open.
 *
 * ## Stream id constraints
 *
 * `streamId` MUST NOT contain `:`. `storeEvent` asserts this so
 * embedders using custom stream ids fail loudly rather than risk
 * prefix-scan collisions (e.g. clearing `a` accidentally hitting
 * `a:b`). Default ids (`connection.id` UUIDs and the literal
 * `_GET_stream`) already satisfy this.
 */
export class DurableObjectEventStore implements EventStore {
  private static readonly EVENT_KEY_PREFIX = "__mcp_event__:";
  private static readonly SEQ_PAD = 16;
  /** DO storage caps multi-key delete at 128. */
  private static readonly DELETE_CHUNK = 128;
  /** Defensive ceiling on a single replay batch. A live stream's
   *  event count is small (progress notifications + final result);
   *  this is here so a pathological history can't OOM the DO. */
  private static readonly REPLAY_LIMIT = 1000;

  private readonly storage: DurableObjectStorage;

  /** In-memory seq counters per stream, rehydrated lazily from storage. */
  private readonly seqByStream = new Map<StreamId, number>();
  private readonly seqInit = new Map<StreamId, Promise<void>>();

  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
  }

  async storeEvent(
    streamId: StreamId,
    message: JSONRPCMessage
  ): Promise<EventId> {
    if (streamId.includes(":")) {
      // Event keys are `__mcp_event__:<streamId>:<seqHex>` — a `:` in
      // streamId would let prefix scans cross stream boundaries.
      throw new Error(
        `DurableObjectEventStore: streamId must not contain ':' (got ${JSON.stringify(streamId)})`
      );
    }
    await this.ensureSeqLoaded(streamId);
    const seq = (this.seqByStream.get(streamId) ?? 0) + 1;
    this.seqByStream.set(streamId, seq);

    const seqHex = seq
      .toString(16)
      .padStart(DurableObjectEventStore.SEQ_PAD, "0");
    const eventId = `${streamId}:${seqHex}`;
    const eventKey = `${DurableObjectEventStore.EVENT_KEY_PREFIX}${eventId}`;

    await this.storage.put(eventKey, message);
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
    // `list({ start })` is inclusive, and we want strictly-after
    // semantics. Appending `\x00` (the smallest byte) to the last
    // event's key produces a key that sorts immediately after it, so
    // the list excludes the boundary event without a post-filter.
    const startKey = `${DurableObjectEventStore.EVENT_KEY_PREFIX}${lastEventId}\x00`;
    // DO `storage.list()` with no `limit` loads everything into memory.
    // Stream histories are normally small (progress events + result),
    // but cap the batch defensively. Clients can reconnect again to
    // drain past the cap if they ever produce that many events.
    const rows = await this.storage.list<JSONRPCMessage>({
      prefix,
      start: startKey,
      limit: DurableObjectEventStore.REPLAY_LIMIT
    });

    for (const [key, message] of rows) {
      const eventId = key.slice(
        DurableObjectEventStore.EVENT_KEY_PREFIX.length
      );
      await send(eventId, message);
    }
    return streamId;
  }

  /**
   * Drop the event log for a single stream. Called by the transport
   * immediately after a POST's final response has been written to the
   * wire — no future `Last-Event-ID` for this stream is expected to
   * resolve.
   *
   * Lists and deletes in chunks of {@link DELETE_CHUNK} (128, the DO
   * storage cap) so we never load the entire event log into memory.
   * After deleting, the next `list` call won't see the deleted keys,
   * so passing `start: <prefix>` again is enough — no cursor bookkeeping.
   */
  async clearStream(streamId: StreamId): Promise<void> {
    const prefix = `${DurableObjectEventStore.EVENT_KEY_PREFIX}${streamId}:`;
    for (;;) {
      const rows = await this.storage.list({
        prefix,
        limit: DurableObjectEventStore.DELETE_CHUNK
      });
      if (rows.size === 0) break;
      await this.storage.delete([...rows.keys()]);
    }
    this.seqByStream.delete(streamId);
    this.seqInit.delete(streamId);
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
