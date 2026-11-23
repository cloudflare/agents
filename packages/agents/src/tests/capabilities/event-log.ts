import { DurableObject, RpcTarget } from "cloudflare:workers";
import { Lifecycle } from "../../lifecycle";
import { Streams } from "../../streams/streams";
import { WebSockets } from "../../websockets";
import {
  declareEventLog,
  type EventLog,
  type EventLogBatch
} from "../../internal";

/** One stored block of a log's stream: chunk seqs `[seq_from, seq_to)`. */
type StoredRow = { seq_from: number; seq_to: number };

/** What a browser client may call: publish to `feed`. */
class EventLogCallables extends RpcTarget {
  readonly #publish: (data: unknown) => number;

  constructor(publish: (data: unknown) => number) {
    super();
    this.#publish = publish;
  }

  publish(data: unknown): number {
    return this.#publish(data);
  }
}

/**
 * A plain Durable Object with the WebSockets capability and three event
 * logs, for the event log contract tests:
 *
 * - `feed`: small retention (5 events) and batches (3 events, a long delay
 *   so buffered events stay buffered until a test flushes or evicts), and
 *   a snapshot that reports the head it was taken at.
 *
 * Each log is a stream of the object's `Streams` capability.
 * - `bare`: no snapshot.
 * - `guarded`: only connections opened with `?allow` may follow it.
 */
export class EventLogObject extends DurableObject<Cloudflare.Env> {
  readonly #streams = new Streams();

  readonly #webSockets = new WebSockets({
    callables: new EventLogCallables((data) => this.#feed.publish(data)),
    handlers: {
      // `?listState` gives the connection state that is not an object.
      onConnect: (connection, { request }) => {
        const params = new URL(request.url).searchParams;
        if (params.has("listState")) connection.setState(["a", "b"]);
        if (params.has("mapState")) connection.setState(new Map([["k", "v"]]));
      }
    }
  });

  readonly #feed: EventLog<unknown, { at: number }> = declareEventLog<
    unknown,
    { at: number }
  >(this.#webSockets, "feed", {
    streams: this.#streams,
    retention: { maxEvents: 5 },
    batching: { maxEvents: 3, maxDelayMs: 60_000 },
    maxEventBytes: 600_000,
    snapshot: (): { at: number } => ({ at: this.#feed.head.seq })
  });

  readonly #bare = declareEventLog(this.#webSockets, "bare", {
    streams: this.#streams
  });

  /** Byte retention (300 KB) and the highest event ceiling (1.9 MB). */
  readonly #small = declareEventLog(this.#webSockets, "small", {
    streams: this.#streams,
    retention: { maxBytes: 300_000 },
    maxEventBytes: 1_900_000
  });

  /** The highest event ceiling (1.9 MB) with default retention. */
  readonly #big = declareEventLog(this.#webSockets, "big", {
    streams: this.#streams,
    maxEventBytes: 1_900_000
  });

  readonly #guarded = declareEventLog(this.#webSockets, "guarded", {
    streams: this.#streams,
    canSubscribe: (connection) =>
      new URL(connection.uri ?? "https://x").searchParams.has("allow")
  });

  readonly lifecycle = Lifecycle.install(this)
    .use(this.#streams)
    .use(this.#webSockets);

  #batch: EventLogBatch | undefined;

  #log(name: string) {
    if (name === "feed") return this.#feed;
    if (name === "bare") return this.#bare;
    if (name === "small") return this.#small;
    if (name === "big") return this.#big;
    return this.#guarded;
  }

  async publish(log: string, data: unknown): Promise<number> {
    await this.lifecycle.start();
    return this.#log(log).publish(data);
  }

  async publishMany(log: string, count: number): Promise<number[]> {
    await this.lifecycle.start();
    const seqs: number[] = [];
    for (let i = 0; i < count; i++) seqs.push(this.#log(log).publish(i));
    return seqs;
  }

  /** Publish one event of `bytes` characters; returns the error, if any. */
  async publishSized(bytes: number): Promise<string | number> {
    await this.lifecycle.start();
    try {
      return this.#feed.publish("x".repeat(bytes));
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** Publish `count` events of `text`; returns the last seq. */
  async publishText(log: string, text: string, count = 1): Promise<number> {
    await this.lifecycle.start();
    let seq = 0;
    for (let i = 0; i < count; i++) seq = this.#log(log).publish(text);
    return seq;
  }

  /**
   * Publish one event; returns its seq, or the error message when the
   * publish throws (a rejected RPC would surface as unhandled).
   */
  async tryPublish(log: string, data: string): Promise<number | string> {
    await this.lifecycle.start();
    try {
      return this.#log(log).publish(data);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** Publish an object whose `toJSON` gives a new value on every call. */
  async publishCounter(): Promise<number> {
    await this.lifecycle.start();
    let calls = 0;
    return this.#feed.publish({ toJSON: () => ++calls });
  }

  async openBatch(log = "feed"): Promise<void> {
    await this.lifecycle.start();
    this.#batch = this.#log(log).batch();
  }

  async append(data: unknown): Promise<number> {
    await this.lifecycle.start();
    if (!this.#batch) throw new Error("no open batch");
    return this.#batch.append(data);
  }

  async appendSized(bytes: number): Promise<number> {
    await this.lifecycle.start();
    if (!this.#batch) throw new Error("no open batch");
    return this.#batch.append("x".repeat(bytes));
  }

  async closeBatch(): Promise<void> {
    await this.lifecycle.start();
    this.#batch?.close();
    this.#batch = undefined;
  }

  /** Reset the object the way a crash does: in-memory state is gone. */
  crash(): void {
    this.ctx.abort("simulated crash");
  }

  async connectionState(id: string): Promise<unknown> {
    await this.lifecycle.start();
    return this.#webSockets.getConnection(id)?.state;
  }

  async head(log = "feed"): Promise<{ epoch: string; seq: number }> {
    await this.lifecycle.start();
    return this.#log(log).head;
  }

  /**
   * Make block writes of a log's stream fail (only block number `block`
   * when given), or stop doing so.
   */
  async failWrites(log: string, fail: boolean, block?: number): Promise<void> {
    await this.lifecycle.start();
    const trigger = `fail_${log}`;
    this.ctx.storage.sql.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    if (!fail) return;
    const only = block === undefined ? "" : ` AND NEW.block = ${block}`;
    this.ctx.storage.sql.exec(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON cf_agents_stream_blocks
       WHEN NEW.stream_id = 'log:${log}'${only}
       BEGIN SELECT RAISE(ABORT, 'planted write failure'); END`
    );
  }

  async rows(log = "feed"): Promise<StoredRow[]> {
    await this.lifecycle.start();
    return this.ctx.storage.sql
      .exec<StoredRow>(
        `SELECT seq_from, seq_to FROM cf_agents_stream_blocks
         WHERE stream_id = ? ORDER BY block`,
        `log:${log}`
      )
      .toArray();
  }
}
