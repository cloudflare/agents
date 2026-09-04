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
 *   tail (the same in-isolate wakeups the SQLite log uses). Memory holds
 *   only the unflushed tail plus a small hot window of landed lines: once
 *   a segment's put resolves its lines are evicted, and a reader further
 *   behind reads that segment from R2. A stream's length never grows the
 *   isolate's memory.
 * - Every `everyChunks` appends or `everyMs` after the first unflushed one,
 *   the new lines are put as one immutable segment
 *   `<prefix><id>/seg/<epoch>/<from>-<to>`. Each landed segment is the
 *   durability: when the isolate dies, everything up to the last landed
 *   segment is in R2 and the loss window is the cadence. A put that fails
 *   after retries folds its range into the next checkpoint; nothing is
 *   skipped.
 * - The stream row's cursor is stamped from landed segments, throttled to
 *   one row write per few seconds, so `status()` never reports more than
 *   R2 holds and the stamp costs a fraction of the puts.
 * - `open()` on a stream whose isolate died lists the segments once,
 *   keeps the contiguous chain (deleting keys it does not cover, so a
 *   discarded generation is never spliced back in) and continues in a new
 *   epoch from the chain's end without loading it into memory.
 * - Settlement streams the segments back through one exact-size put at
 *   `<id>/body` so replay is a single object, then drops the segments.
 *   The segments stay readable until the body lands; a death mid-settle
 *   loses nothing.
 * - Replay of a settled body caches small bodies whole; large ones get a
 *   line-offset index and ranged gets, so replay memory is bounded by the
 *   index, not the body.
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

/** Landed lines kept in memory behind the tail for live readers. */
const HOT_WINDOW_BYTES = 256 * 1024;
/** Stream-row cursor stamps are throttled to one per this interval. */
const STAMP_EVERY_MS = 5000;
/** Settled bodies up to this size are cached whole; larger ones indexed. */
const SMALL_BODY_BYTES = 1024 * 1024;
/** Total bytes of cached bodies, indexes and fetched segments. */
const READ_CACHE_BYTES = 8 * 1024 * 1024;
/** R2 bulk delete accepts at most this many keys per call. */
const DELETE_BATCH = 1000;
const PUT_ATTEMPTS = 3;

const utf8 = new TextEncoder();

/** @internal Tunables for the R2 chunk log. */
export interface R2LogOptions {
  bucket: R2Bucket;
  /** Key prefix for every object the log writes. Default: `streams/`. */
  prefix?: string;
  checkpoint?: R2CheckpointOptions;
  /** `cursor` chunks are durable in R2. Monotone: keep the max. */
  onDurable: (streamId: string, cursor: number) => void;
}

type Segment = {
  key: string;
  epoch: number;
  from: number;
  to: number;
  bytes: number;
};

/** One live (or settling) stream. */
class Sink {
  /** Seq of `lines[0]`. Everything below is in landed segments. */
  base: number;
  readonly lines: string[] = [];
  readonly lineBytes: number[] = [];
  /** First seq not yet handed to a segment put. */
  flushedTo: number;
  /** Highest seq (exclusive) whose segment put has resolved. */
  durable: number;
  /** Landed segments in seq order (the resumed chain, then this epoch's). */
  readonly landed: Segment[];
  timer: ReturnType<typeof setTimeout> | null = null;
  /** Segment puts in flight, chained so they land in order. */
  chain: Promise<void> = Promise.resolve();
  lastAppendAt: number | null = null;
  lastStampAt = 0;
  state: "streaming" | "settling" | "done" = "streaming";

  constructor(
    readonly epoch: number,
    chain: Segment[]
  ) {
    this.landed = chain;
    const cursor = chain.length > 0 ? chain[chain.length - 1].to : 0;
    this.base = cursor;
    this.flushedTo = cursor;
    this.durable = cursor;
  }

  get cursor(): number {
    return this.base + this.lines.length;
  }
}

/** A settled body's replay handle. */
type Body =
  | { kind: "small"; lines: string[]; bytes: number }
  | { kind: "indexed"; offsets: number[]; size: number; bytes: number };

export class R2ChunkLog {
  readonly #bucket: R2Bucket;
  readonly #prefix: string;
  readonly #every: Required<R2CheckpointOptions>;
  readonly #onDurable: R2LogOptions["onDurable"];
  readonly #sinks = new Map<string, Sink>();
  /** Settlements in flight, awaitable through `flush()`. */
  readonly #settling = new Map<string, Promise<void>>();
  /** Replay cache, LRU by insertion order, byte-bounded. */
  readonly #cache = new Map<string, { bytes: number; value: unknown }>();
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

  #parseSegment(streamId: string, key: string, bytes: number): Segment | null {
    const rest = key.slice(this.#segmentPrefix(streamId).length);
    const match = /^(\d+)\/(\d+)-(\d+)$/.exec(rest);
    if (!match) return null;
    return {
      key,
      epoch: Number(match[1]),
      from: Number(match[2]),
      to: Number(match[3]),
      bytes
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
    return this.#sinks.get(streamId)?.cursor;
  }

  /** Chunks known to have landed in R2, or undefined when not in memory. */
  durableCursor(streamId: string): number | undefined {
    return this.#sinks.get(streamId)?.durable;
  }

  lastAppendAt(streamId: string): number | null {
    return this.#sinks.get(streamId)?.lastAppendAt ?? null;
  }

  /** @internal Lines held in memory for a live stream (tests). */
  memoryLines(streamId: string): number {
    return this.#sinks.get(streamId)?.lines.length ?? 0;
  }

  /** Start a fresh stream: an empty memory log, epoch 0. */
  open(streamId: string): void {
    this.#uncache(streamId);
    this.#sinks.set(streamId, new Sink(0, []));
  }

  /**
   * Resume a stream whose producer's isolate is gone: one list, keep the
   * contiguous chain, delete every key it does not cover (a discarded
   * generation must never be spliced back in), and continue in a new epoch
   * from the chain's end. Nothing is loaded into memory. Returns the
   * recovered cursor.
   */
  async resume(streamId: string): Promise<number> {
    const existing = this.#sinks.get(streamId);
    if (existing) return existing.cursor;
    this.#uncache(streamId);
    const segments = await this.#listSegments(streamId);
    const chain = contiguousChain(segments);
    const covered = new Set(chain.map((s) => s.key));
    await this.#deleteKeys(
      segments.filter((s) => !covered.has(s.key)).map((s) => s.key)
    );
    const epoch = segments.reduce((max, s) => Math.max(max, s.epoch), -1) + 1;
    const sink = new Sink(epoch, chain);
    this.#sinks.set(streamId, sink);
    // Stamps are throttled while live, so the row may lag the chain; the
    // listing just paid for is the exact durable cursor.
    this.#onDurable(streamId, sink.cursor);
    return sink.cursor;
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
    const seq = sink.cursor;
    sink.lines.push(line);
    sink.lineBytes.push(utf8.encode(line).byteLength);
    sink.lastAppendAt = Date.now();
    if (sink.cursor - sink.flushedTo >= this.#every.everyChunks) {
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
   * Settle: checkpoint what is left, wait for every segment to land, write
   * the body as one exact-size object, then drop the segments. Readers are
   * served throughout, and the segments stay readable until the body
   * exists, so a death mid-settle loses nothing.
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
        await this.#writeBody(streamId, sink);
        this.#onDurable(streamId, sink.cursor);
        await this.#deleteKeys(sink.landed.map((s) => s.key));
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
   * One page of chunks from `from`, in seq order. A live stream is served
   * from memory at its tail and from landed segments further back; a
   * settled stream from its body (cached whole when small, otherwise by
   * line-offset index and ranged get); a stream whose producer died and
   * has not resumed, from its segment chain.
   */
  async readPage(
    streamId: string,
    from: number,
    limit: number
  ): Promise<StreamChunkRow[]> {
    const sink = this.#sinks.get(streamId);
    if (sink) return this.#readChain(streamId, sink.landed, sink, from, limit);
    const body = await this.#body(streamId);
    if (body) return this.#readFromBody(streamId, body, from, limit);
    // No body: a dead producer's chain (its segments are still growing
    // until it resumes, so the list is fresh every page).
    const chain = contiguousChain(await this.#listSegments(streamId));
    return this.#readChain(streamId, chain, null, from, limit);
  }

  /**
   * Fill one page from landed segments and, for a live sink, from memory
   * once `from` reaches its base. A page shorter than `limit` means the
   * durable tail was reached, which is what the reader loop keys off.
   */
  async #readChain(
    streamId: string,
    segments: Segment[],
    sink: Sink | null,
    from: number,
    limit: number
  ): Promise<StreamChunkRow[]> {
    const page: StreamChunkRow[] = [];
    while (page.length < limit) {
      if (sink && from >= sink.base) {
        const offset = from - sink.base;
        page.push(
          ...rows(
            streamId,
            from,
            sink.lines.slice(offset, offset + limit - page.length)
          )
        );
        break;
      }
      const segment = segments.find((s) => s.from <= from && from < s.to);
      if (!segment) break;
      const lines = await this.#segmentLines(streamId, segment);
      if (!lines) break;
      const offset = from - segment.from;
      const take = lines.slice(offset, offset + limit - page.length);
      page.push(...rows(streamId, from, take));
      from += take.length;
      if (take.length === 0) break;
    }
    return page;
  }

  async #segmentLines(
    streamId: string,
    segment: Segment
  ): Promise<string[] | null> {
    const cacheKey = `${streamId}#${segment.key}`;
    const cached = this.#cached<string[]>(cacheKey);
    if (cached) return cached;
    const object = await this.#bucket.get(segment.key);
    if (!object) return null;
    const lines = splitLines(await object.text());
    this.#cacheSet(cacheKey, lines, segment.bytes);
    return lines;
  }

  async #body(streamId: string): Promise<Body | null> {
    const cached = this.#cached<Body>(streamId);
    if (cached) return cached;
    const head = await this.#bucket.head(this.bodyKey(streamId));
    if (!head) return null;
    let body: Body;
    if (head.size <= SMALL_BODY_BYTES) {
      const object = await this.#bucket.get(this.bodyKey(streamId));
      if (!object) return null;
      body = {
        kind: "small",
        lines: splitLines(await object.text()),
        bytes: head.size
      };
    } else {
      const object = await this.#bucket.get(this.bodyKey(streamId));
      if (!object) return null;
      const offsets = await lineOffsets(object.body);
      body = {
        kind: "indexed",
        offsets,
        size: head.size,
        bytes: offsets.length * 8
      };
    }
    this.#cacheSet(streamId, body, body.bytes);
    return body;
  }

  async #readFromBody(
    streamId: string,
    body: Body,
    from: number,
    limit: number
  ): Promise<StreamChunkRow[]> {
    if (body.kind === "small") {
      return rows(streamId, from, body.lines.slice(from, from + limit));
    }
    const count = body.offsets.length;
    if (from >= count) return [];
    const end = Math.min(count, from + limit);
    const start = body.offsets[from];
    const stop = end < count ? body.offsets[end] : body.size;
    const object = await this.#bucket.get(this.bodyKey(streamId), {
      range: { offset: start, length: stop - start }
    });
    if (!object) return [];
    return rows(streamId, from, splitLines(await object.text()));
  }

  #cached<T>(key: string): T | undefined {
    const entry = this.#cache.get(key);
    if (!entry) return undefined;
    // Refresh recency: Map iteration order is insertion order.
    this.#cache.delete(key);
    this.#cache.set(key, entry);
    return entry.value as T;
  }

  #cacheSet(key: string, value: unknown, bytes: number): void {
    if (bytes > READ_CACHE_BYTES) return;
    this.#uncache(key);
    while (this.#cacheBytes + bytes > READ_CACHE_BYTES && this.#cache.size) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#uncache(oldest);
    }
    this.#cache.set(key, { value, bytes });
    this.#cacheBytes += bytes;
  }

  /** Drop a stream's body and any of its segments from the cache. */
  #uncache(streamId: string): void {
    for (const key of [...this.#cache.keys()]) {
      if (key === streamId || key.startsWith(`${streamId}#`)) {
        const entry = this.#cache.get(key);
        if (entry) this.#cacheBytes -= entry.bytes;
        this.#cache.delete(key);
      }
    }
  }

  // ── Segments ─────────────────────────────────────────────────────────────

  #checkpoint(streamId: string, sink: Sink): void {
    if (sink.timer !== null) {
      clearTimeout(sink.timer);
      sink.timer = null;
    }
    const from = sink.flushedTo;
    const to = sink.cursor;
    if (to === from) return;
    sink.flushedTo = to;
    const key = this.#segmentKey(streamId, sink.epoch, from, to);
    const start = from - sink.base;
    const body = sink.lines.slice(start, to - sink.base).join("");
    let bytes = 0;
    for (let i = start; i < to - sink.base; i++) bytes += sink.lineBytes[i];
    // Chained, so segments land in order and a slow put simply widens the
    // next segment instead of racing it; the durable cursor is monotone.
    sink.chain = sink.chain.then(async () => {
      if (!(await this.#putWithRetry(key, body))) {
        // Not durable. Fold the range back into the next checkpoint: the
        // next segment starts here and the chain picker prefers the wider
        // key, so nothing is skipped and nothing is evicted below it.
        sink.flushedTo = Math.min(sink.flushedTo, from);
        return;
      }
      if (sink.durable !== from) return; // an earlier range failed
      sink.durable = to;
      sink.landed.push({ key, epoch: sink.epoch, from, to, bytes });
      this.#evict(sink);
      const now = Date.now();
      if (
        sink.state !== "done" &&
        (sink.state === "settling" || now - sink.lastStampAt >= STAMP_EVERY_MS)
      ) {
        sink.lastStampAt = now;
        this.#onDurable(streamId, to);
      }
    });
  }

  async #putWithRetry(key: string, body: string): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.#bucket.put(key, body);
        return true;
      } catch {
        if (attempt >= PUT_ATTEMPTS) return false;
        await new Promise((r) => setTimeout(r, 200 * 4 ** (attempt - 1)));
      }
    }
  }

  /**
   * Drop landed lines from memory beyond the hot window. Only durable
   * lines are ever evicted, so a reader behind `base` always finds them
   * in a landed segment.
   */
  #evict(sink: Sink): void {
    let retained = 0;
    for (let i = sink.durable - sink.base - 1; i >= 0; i--) {
      retained += sink.lineBytes[i];
      if (retained > HOT_WINDOW_BYTES) {
        const drop = i + 1;
        sink.lines.splice(0, drop);
        sink.lineBytes.splice(0, drop);
        sink.base += drop;
        return;
      }
    }
  }

  /**
   * The settled body. Everything still in memory is one put from memory;
   * otherwise the landed segments are streamed back through one put of
   * their known total size, so the body never has to fit in memory.
   */
  async #writeBody(streamId: string, sink: Sink): Promise<void> {
    const meta = { httpMetadata: { contentType: "application/x-ndjson" } };
    if (sink.base === 0) {
      await this.#bucket.put(this.bodyKey(streamId), sink.lines.join(""), meta);
      return;
    }
    const tail = sink.lines.slice(sink.durable - sink.base).join("");
    const total =
      sink.landed.reduce((n, s) => n + s.bytes, 0) +
      utf8.encode(tail).byteLength;
    const fixed = new FixedLengthStream(total);
    const put = this.#bucket.put(this.bodyKey(streamId), fixed.readable, meta);
    const writer = fixed.writable.getWriter();
    try {
      for (const segment of sink.landed) {
        const object = await this.#bucket.get(segment.key);
        if (!object) throw new Error(`segment ${segment.key} missing`);
        for await (const chunk of object.body) await writer.write(chunk);
      }
      if (tail.length > 0) await writer.write(utf8.encode(tail));
      await writer.close();
    } catch (error) {
      await writer.abort(error).catch(() => {});
      await put.catch(() => {});
      throw error;
    }
    await put;
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
        const segment = this.#parseSegment(streamId, object.key, object.size);
        if (segment) segments.push(segment);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return segments;
  }

  async #deleteKeys(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      await this.#bucket.delete(keys.slice(i, i + DELETE_BATCH));
    }
  }
}

/**
 * The longest chain of segments covering seq 0 upward without a gap. When
 * several segments start at the same seq the newest epoch wins, then the
 * widest: a resumed generation wrote past everything the older one made
 * durable, and a re-flushed range supersedes the narrower put it replaced.
 */
function contiguousChain(segments: Segment[]): Segment[] {
  const byFrom = new Map<number, Segment>();
  for (const segment of segments) {
    const current = byFrom.get(segment.from);
    if (
      !current ||
      segment.epoch > current.epoch ||
      (segment.epoch === current.epoch && segment.to > current.to)
    ) {
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

function rows(
  streamId: string,
  from: number,
  lines: string[]
): StreamChunkRow[] {
  return lines.map((line, i) => ({
    stream_id: streamId,
    seq: from + i,
    chunk: line.slice(0, -1),
    created_at: 0
  }));
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
    lines.push(text.slice(start, end + 1));
    start = end + 1;
  }
  return lines;
}

/** Byte offset of every line start, from one streaming scan of the body. */
async function lineOffsets(
  body: ReadableStream<Uint8Array>
): Promise<number[]> {
  const offsets: number[] = [];
  let position = 0;
  let atLineStart = true;
  for await (const chunk of body) {
    for (let i = 0; i < chunk.length; i++) {
      if (atLineStart) {
        offsets.push(position + i);
        atLineStart = false;
      }
      if (chunk[i] === 0x0a) atLineStart = true;
    }
    position += chunk.length;
  }
  return offsets;
}
