import { Agent } from "../../index.ts";
import type { Connection, WSMessage } from "../../index.ts";
import { Streams } from "../../streams/index.ts";
import { declareEventLog } from "../../websockets/websockets.ts";
import type { WebSockets } from "../../websockets/websockets.ts";

// ── SubAgent: an event log inside a facet ──────────────────────────
// The log's stream lives in the facet's own SQLite; its followers
// connect through the root's `/sub/` route.

export class EventLogSubAgent extends Agent {
  readonly streams = new Streams();
  readonly feed = declareEventLog<unknown>(
    // SAFETY: tests reach Agent's private WebSockets capability to declare a
    // log on it; there is no public Agent API for event logs yet.
    (this as unknown as { _webSockets: WebSockets })._webSockets,
    "feed",
    {
      streams: this.streams,
      retention: { maxEvents: 5 },
      batching: { maxEvents: 3, maxDelayMs: 60_000 }
    }
  );
  #batch: ReturnType<typeof this.feed.batch> | undefined;

  constructor(...args: ConstructorParameters<typeof Agent>) {
    super(...args);
    this.lifecycle.use(this.streams);
  }

  /** `publish:<data>` and `append:<data>` from a follower's own socket. */
  override onMessage(_connection: Connection, message: WSMessage): void {
    if (typeof message !== "string") return;
    if (message.startsWith("publish:")) this.feed.publish(message.slice(8));
    if (message.startsWith("append:")) {
      this.#batch ??= this.feed.batch();
      this.#batch.append(message.slice(7));
    }
  }

  publish(data: string): number {
    return this.feed.publish(data);
  }

  head(): { epoch: string; seq: number } {
    return this.feed.head;
  }

  rows(): { seq_from: number; seq_to: number }[] {
    return this.ctx.storage.sql
      .exec<{ seq_from: number; seq_to: number }>(
        `SELECT seq_from, seq_to FROM cf_agents_stream_blocks
         WHERE stream_id = 'log:feed' ORDER BY block`
      )
      .toArray();
  }
}
