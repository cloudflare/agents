/**
 * R2 chunk log for the Streams capability: a write-ahead log of segment
 * objects. Configured with `new Streams({ r2: env.BUCKET })`, chunks leave
 * DO SQLite for R2; the stream row (state, tag index, metadata, cursor)
 * stays in SQLite, where a point read or tag lookup costs nothing.
 *
 * Why segments, measured on real R2 (2026-09-03): R2 has no append, a
 * `put()` of unknown length is rejected, and a put that has not completed
 * stores nothing. The only way to continuously save a stream is to put a
 * small object every so often. So:
 *
 * - `append()` is synchronous into an in-memory line log that live readers
 *   tail (the same in-isolate wakeups the SQLite log uses).
 * - Every `everyChunks` appends or `everyMs` after the first unflushed one,
 *   the new lines are put as one immutable segment
 *   `<prefix><id>/seg/<epoch>/<from>-<to>`. Each landed segment is the
 *   durability: when the isolate dies, everything up to the last landed
 *   segment is in R2 and the loss window is the cadence.
 * - The stream row's cursor is stamped only after a segment's put resolves,
 *   so `status()` never reports more than R2 holds.
 * - `open()` on a stream whose isolate died rebuilds the log from the
 *   contiguous segment chain, starts a new epoch, and deletes keys the chain
 *   does not cover (deletes are free), so a later generation can never be
 *   spliced with a discarded one.
 * - Settlement puts the whole body as one exact-size object
 *   `<prefix><id>/body` so replay is a single get, then drops the segments.
 *   The segments stay readable until the body lands; a death mid-settle
 *   loses nothing.
 *
 * Cost: one Class A op per checkpoint, none per chunk. One R2 put costs
 * the same as 4.5 billed SQLite row writes, so this log is cheaper than the
 * SQLite log whenever a checkpoint covers more than ~4.5 stored rows.
 */

import type { StreamChunkRow } from "./types";

/** Checkpoint cadence: the loss window when the isolate dies. */
export interface R2CheckpointOptions {
  /** Put a segment after this many appends. Default: 25. */
  readonly everyChunks?: number;
  /** ...or this long after the first unflushed append. Default: 1000. */
  readonly everyMs?: number;
}

export const DEFAULT_CHECKPOINT: Required<R2CheckpointOptions> = {
  everyChunks: 25,
  everyMs: 1000
};

/** Parsed bodies kept in memory for replaying settled streams. */
const READ_CACHE_BYTES = 8 * 1024 * 1024;
/** R2 bulk delete accepts at most this many keys per call. */
const DELETE_BATCH = 1000;

const utf8 = new TextEncoder();

/** @internal Tunables for the R2 chunk log. */
export interface R2LogOptions {
  bucket: R2Bucket;
  /** Key prefix for every object the log writes. Default: `streams/`. */
  prefix?: string;
  checkpoint?: R2CheckpointOptions;
  /** A segment landed: `cursor` chunks are durable. Monotone, keep the max. */
  onDurable: (streamId: string, cursor: number) => void;
}

/** One live (or settling) stream's memory log. */
class Sink {
  readonly lines: string[] = [];
  bytes = 0;
  /** First seq not yet handed to a segment put. */
  flushedTo: number;
  /** Highest seq (exclusive) whose segment put has resolved. */
  durable: number;
  timer: ReturnType<typeof setTimeout> | null = null;
  /** Segment puts in flight, chained so they land in order. */
  chain: Promise<void> = Promise.resolve();
  lastAppendAt: number | null = null;
  state: "streaming" | "settling" | "done" = "streaming";

  constructor(
    readonly epoch: number,
    recovered: number
  ) {
    this.flushedTo = recovered;
    this.durable = recovered;
  }
}

type Segment = { key: string; epoch: number; from: number; to: number };

export class R2ChunkLog {
  readonly #bucket: R2Bucket;
  readonly #prefix: string;
  readonly #every: Required<R2CheckpointOptions>;
  readonly #onDurable: R2LogOptions["onDurable"];
  readonly #sinks = new Map<string, Sink>();
  /** Settlements in flight, awaitable through `flush()`. */
  readonly #settling = new Map<string, Promise<void>>();
  /** Replay cache: stream id → lines, LRU by insertion order, byte-bounded. */
  readonly #cache = new Map<string, { lines: string[]; bytes: number }>();
  #cacheBytes = 0;

  constructor(options: R2LogOptions) {
    this.#bucket = options.bucket;
    this.#prefix = options.prefix ?? "streams/";
    this.#every = {
      everyChunks: Math.max(
        1,
        options.checkpoint?.everyChunks ?? DEFAULT_CHECKPOINT.everyChunks
      ),
      everyMs: Math.max(
        0,
        options.checkpoint?.everyMs ?? DEFAULT_CHECKPOINT.everyMs
      )
    };
    this.#onDurable = options.onDurable;
  }

  // ── Keys ─────────────────────────────────────────────────────────────────

  #streamPrefix(streamId: string): string {
    return `${this.#prefix}${encodeURIComponent(streamId)}/`;
  }

  /** The settled body: one exact-size NDJSON object. */
  bodyKey(streamId: string): string {
    return `${this.#streamPrefix(streamId)}body`;
  }

  #segmentPrefix(streamId: string): string {
    return `${this.#streamPrefix(streamId)}seg/`;
  }

  #segmentKey(
    streamId: string,
    epoch: number,
    from: number,
    to: number
  ): string {
    return `${this.#segmentPrefix(streamId)}${pad(epoch)}/${pad(from)}-${pad(to)}`;
  }

  #parseSegment(streamId: string, key: string): Segment | null {
    const rest = key.slice(this.#segmentPrefix(streamId).length);
    const match = /^(\d+)\/(\d+)-(\d+)$/.exec(rest);
    if (!match) return null;
    return {
      key,
      epoch: Number(match[1]),
      from: Number(match[2]),
      to: Number(match[3])
    };
  }

  // ── Producer ─────────────────────────────────────────────────────────────

  /** True when this isolate holds the stream's log. */
  has(streamId: string): boolean {
    return this.#sinks.has(streamId);
  }

  /**
   * True while this isolate's log accepts appends: a sink exists in
   * `streaming` state only between open() and settle, so the producer's
   * hot path needs no stream-row read to prove liveness.
   */
  isLive(streamId: string): boolean {
    return this.#sinks.get(streamId)?.state === "streaming";
  }

  /** The live cursor, or undefined when the stream is not in memory. */
  cursor(streamId: string): number | undefined {
    return this.#sinks.get(streamId)?.lines.length;
  }

  /** Chunks known to have landed in R2, or undefined when not in memory. */
  durableCursor(streamId: string): number | undefined {
    return this.#sinks.get(streamId)?.durable;
  }

  lastAppendAt(streamId: string): number | null {
    return this.#sinks.get(streamId)?.lastAppendAt ?? null;
  }

  /** Start a fresh stream: an empty memory log, epoch 0. */
  open(streamId: string): void {
    this.#uncache(streamId);
    this.#sinks.set(streamId, new Sink(0, 0));
  }

  /**
   * Resume a stream whose producer's isolate is gone: rebuild the memory
   * log from the contiguous segment chain, delete every key the chain does
   * not cover (a discarded generation must never be spliced back in), and
   * continue in a new epoch. Returns the recovered cursor.
   */
  async resume(streamId: string): Promise<number> {
    const existing = this.#sinks.get(streamId);
    if (existing) return existing.lines.length;
    this.#uncache(streamId);
    const segments = await this.#listSegments(streamId);
    const chain = contiguousChain(segments);
    const covered = new Set(chain.map((s) => s.key));
    await this.#deleteKeys(
      segments.filter((s) => !covered.has(s.key)).map((s) => s.key)
    );
    const lines = await this.#readSegments(chain);
    const epoch = segments.reduce((max, s) => Math.max(max, s.epoch), -1) + 1;
    const sink = new Sink(epoch, lines.length);
    for (const line of lines) {
      sink.lines.push(line);
      sink.bytes += utf8.encode(line).byteLength;
    }
    this.#sinks.set(streamId, sink);
    return lines.length;
  }

  /**
   * Append one serialized chunk. Synchronous: the memory log is the
   * in-isolate truth; the segment put is batched by the cadence.
   */
  append(streamId: string, chunkJson: string): number {
    const sink = this.#sinks.get(streamId);
    if (!sink || sink.state !== "streaming") {
      throw new Error(
        `Stream "${streamId}" is not open in this isolate; call open() first`
      );
    }
    const line = `${chunkJson}\n`;
    const seq = sink.lines.push(line) - 1;
    sink.bytes += utf8.encode(line).byteLength;
    sink.lastAppendAt = Date.now();
    if (sink.lines.length - sink.flushedTo >= this.#every.everyChunks) {
      this.#checkpoint(streamId, sink);
    } else if (sink.timer === null) {
      sink.timer = setTimeout(
        () => this.#checkpoint(streamId, sink),
        this.#every.everyMs
      );
    }
    return seq;
  }

  /**
   * Settle: checkpoint what is left, wait for every segment to land, put
   * the whole body as one exact-size object, then drop the segments. The
   * memory log keeps serving readers throughout, and the segments stay
   * readable until the body exists, so a death mid-settle loses nothing.
   */
  settle(streamId: string): Promise<void> {
    const sink = this.#sinks.get(streamId);
    if (!sink || sink.state !== "streaming") {
      return this.#settling.get(streamId) ?? Promise.resolve();
    }
    sink.state = "settling";
    this.#checkpoint(streamId, sink);
    const done = (async () => {
      try {
        await sink.chain;
        await this.#bucket.put(this.bodyKey(streamId), sink.lines.join(""), {
          httpMetadata: { contentType: "application/x-ndjson" }
        });
        this.#onDurable(streamId, sink.lines.length);
        await this.#deleteKeys(
          (await this.#listSegments(streamId)).map((s) => s.key)
        );
      } finally {
        sink.state = "done";
        this.#sinks.delete(streamId);
        this.#settling.delete(streamId);
      }
    })();
    this.#settling.set(streamId, done);
    return done;
  }

  /** Every settlement still in flight (one stream, or all). */
  flush(streamId?: string): Promise<void> {
    if (streamId !== undefined) {
      return this.#settling.get(streamId) ?? Promise.resolve();
    }
    return Promise.all(this.#settling.values()).then(() => undefined);
  }

  /** Remove every object of a stream. Deletes are free. */
  async delete(streamId: string): Promise<void> {
    const sink = this.#sinks.get(streamId);
    if (sink) {
      if (sink.timer !== null) clearTimeout(sink.timer);
      sink.state = "done";
      this.#sinks.delete(streamId);
      await sink.chain;
    }
    this.#uncache(streamId);
    await this.#deleteKeys([
      this.bodyKey(streamId),
      ...(await this.#listSegments(streamId)).map((s) => s.key)
    ]);
  }

  // ── Reader ───────────────────────────────────────────────────────────────

  /**
   * One page of chunks from `from`, in seq order: the memory log while the
   * stream is in this isolate, else the settled body, else the segment
   * chain (a stream whose producer died, or whose settlement was cut off).
   */
  async readPage(
    streamId: string,
    from: number,
    limit: number
  ): Promise<StreamChunkRow[]> {
    const sink = this.#sinks.get(streamId);
    const lines = sink
      ? sink.lines
      : (this.#cached(streamId) ?? (await this.#load(streamId)));
    const rows: StreamChunkRow[] = [];
    for (let seq = from; seq < lines.length && rows.length < limit; seq++) {
      rows.push({
        stream_id: streamId,
        seq,
        chunk: lines[seq].slice(0, -1),
        created_at: 0
      });
    }
    return rows;
  }

  async #load(streamId: string): Promise<string[]> {
    const body = await this.#bucket.get(this.bodyKey(streamId));
    const lines = body
      ? splitLines(await body.text())
      : await this.#readSegments(
          contiguousChain(await this.#listSegments(streamId))
        );
    // Only a settled body is final; a segment chain can still grow, so it
    // is served fresh on every page and never cached.
    if (body) this.#cacheSet(streamId, lines);
    return lines;
  }

  #cached(streamId: string): string[] | undefined {
    const entry = this.#cache.get(streamId);
    if (!entry) return undefined;
    // Refresh recency: Map iteration order is insertion order.
    this.#cache.delete(streamId);
    this.#cache.set(streamId, entry);
    return entry.lines;
  }

  #cacheSet(streamId: string, lines: string[]): void {
    const bytes = lines.reduce((n, l) => n + l.length, 0);
    if (bytes > READ_CACHE_BYTES) return;
    this.#uncache(streamId);
    while (this.#cacheBytes + bytes > READ_CACHE_BYTES && this.#cache.size) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#uncache(oldest);
    }
    this.#cache.set(streamId, { lines, bytes });
    this.#cacheBytes += bytes;
  }

  #uncache(streamId: string): void {
    const entry = this.#cache.get(streamId);
    if (!entry) return;
    this.#cache.delete(streamId);
    this.#cacheBytes -= entry.bytes;
  }

  // ── Segments ─────────────────────────────────────────────────────────────

  #checkpoint(streamId: string, sink: Sink): void {
    if (sink.timer !== null) {
      clearTimeout(sink.timer);
      sink.timer = null;
    }
    const from = sink.flushedTo;
    const to = sink.lines.length;
    if (to === from) return;
    sink.flushedTo = to;
    const key = this.#segmentKey(streamId, sink.epoch, from, to);
    const body = sink.lines.slice(from, to).join("");
    // Chained, so segments land in order and a slow put simply widens the
    // next segment instead of racing it; the durable cursor is monotone.
    sink.chain = sink.chain.then(async () => {
      try {
        await this.#bucket.put(key, body);
      } catch {
        // Not durable; the chain continues. The next segment's `from` is
        // past this gap, so resume() stops the chain here, and the row is
        // not stamped past it.
        return;
      }
      if (sink.durable === from) {
        sink.durable = to;
        if (sink.state !== "done") this.#onDurable(streamId, to);
      }
    });
  }

  async #listSegments(streamId: string): Promise<Segment[]> {
    const segments: Segment[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#bucket.list({
        prefix: this.#segmentPrefix(streamId),
        cursor
      });
      for (const object of page.objects) {
        const segment = this.#parseSegment(streamId, object.key);
        if (segment) segments.push(segment);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return segments;
  }

  async #readSegments(chain: Segment[]): Promise<string[]> {
    const lines: string[] = [];
    for (const segment of chain) {
      const object = await this.#bucket.get(segment.key);
      if (!object) break;
      const got = splitLines(await object.text());
      if (got.length !== segment.to - segment.from) break;
      lines.push(...got);
    }
    return lines;
  }

  async #deleteKeys(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      await this.#bucket.delete(keys.slice(i, i + DELETE_BATCH));
    }
  }
}

/**
 * The longest chain of segments covering seq 0 upward without a gap. When
 * two epochs both cover a `from`, the newest epoch wins: it was written by
 * the generation that resumed from a chain that already included the
 * older one's durable prefix.
 */
function contiguousChain(segments: Segment[]): Segment[] {
  const byFrom = new Map<number, Segment>();
  for (const segment of segments) {
    const current = byFrom.get(segment.from);
    if (!current || segment.epoch > current.epoch) {
      byFrom.set(segment.from, segment);
    }
  }
  const chain: Segment[] = [];
  let next = 0;
  for (;;) {
    const segment = byFrom.get(next);
    if (!segment || segment.to <= segment.from) break;
    chain.push(segment);
    next = segment.to;
  }
  return chain;
}

function pad(n: number): string {
  return String(n).padStart(12, "0");
}

/** NDJSON body → lines with their trailing newline. */
function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (;;) {
    const end = text.indexOf("\n", start);
    if (end === -1) break;
    const line = text.slice(start, end);
    if (line.trim().length > 0) lines.push(`${line}\n`);
    start = end + 1;
  }
  return lines;
}
