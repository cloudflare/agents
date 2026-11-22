import { DurableObject, RpcTarget } from "cloudflare:workers";
import { Lifecycle } from "../../lifecycle";
import {
  WebSockets,
  type EventLog,
  type EventLogBatch
} from "../../websockets";

type StoredRow = {
  seq_from: number;
  seq_to: number;
  kind: string;
  open_until: number | null;
};

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
 * - `bare`: no snapshot.
 * - `guarded`: only connections opened with `?allow` may follow it.
 */
export class EventLogObject extends DurableObject<Cloudflare.Env> {
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

  readonly #feed: EventLog<unknown, { at: number }> = this.#webSockets.log<
    unknown,
    { at: number }
  >("feed", {
    retention: { maxEvents: 5 },
    batching: { maxEvents: 3, maxDelayMs: 60_000 },
    maxEventBytes: 600_000,
    snapshot: (): { at: number } => ({ at: this.#feed.head.seq })
  });

  readonly #bare = this.#webSockets.log("bare");

  readonly #guarded = this.#webSockets.log("guarded", {
    canSubscribe: (connection) =>
      new URL(connection.uri ?? "https://x").searchParams.has("allow")
  });

  readonly lifecycle = Lifecycle.install(this).use(this.#webSockets);

  #batch: EventLogBatch | undefined;

  #log(name: string) {
    if (name === "feed") return this.#feed;
    if (name === "bare") return this.#bare;
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

  async rows(log = "feed"): Promise<StoredRow[]> {
    await this.lifecycle.start();
    return this.ctx.storage.sql
      .exec<StoredRow>(
        `SELECT seq_from, seq_to, kind, open_until FROM cf_agents_event_log_rows
         WHERE log = ? ORDER BY seq_from`,
        log
      )
      .toArray();
  }
}
