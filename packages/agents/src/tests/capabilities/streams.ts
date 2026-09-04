import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "../../lifecycle";
import { Streams } from "../../streams";
import { Tasks, type TaskStep } from "../../tasks";

/**
 * Minimal real host for capability-level Streams tests: a Durable Object
 * whose ONLY capability is Streams, installed through a real Lifecycle over
 * real SQLite — proving the capability stands alone (it needs no alarm at
 * all). Composition with Tasks is proven separately by
 * {@link TaskStreamComposeObject}.
 */
export class StreamHarnessObject extends DurableObject<Cloudflare.Env> {
  readonly streams = new Streams({ maxChunkBytes: 1024 });
  readonly lifecycle = Lifecycle.install(this).use(this.streams);
}

/**
 * The same minimal host with the chunk log in R2: `new Streams({ r2 })`.
 * Stream rows stay in this object's SQLite; chunks go to the bucket.
 */
export class R2StreamHarnessObject extends DurableObject<Cloudflare.Env> {
  readonly streams = new Streams({
    maxChunkBytes: 1024,
    r2: this.env.STREAMS_R2,
    r2Prefix: `t/${this.ctx.id.toString().slice(0, 12)}/`
  });
  readonly lifecycle = Lifecycle.install(this).use(this.streams);
}

/**
 * Streams and Tasks composed on one Lifecycle, exercising the contract the
 * RFC names: a task step appends to a stream it does not own, and a replay
 * after unclean interruption resumes from the stream's own durable cursor —
 * the stream is the recovery evidence, so no chunk is ever duplicated.
 * Neither capability imports the other.
 */
export class TaskStreamComposeObject extends DurableObject<Cloudflare.Env> {
  /** Chunk producers that actually executed (journal hits never append). */
  readonly produced: string[] = [];
  /** Cursor observed at each producer (re)entry — replays resume, not redo. */
  readonly entryCursors: Array<{ streamId: string; cursor: number }> = [];

  readonly streams = new Streams();

  readonly tasks = new Tasks({
    definitions: {
      generate: async (
        input: { streamId: string; total: number },
        step: TaskStep
      ) => {
        return step.do("stream", async () => {
          const stream = await this.streams.open(input.streamId);
          // Resuming producers start from the stream's own cursor, so a
          // replay after interruption never duplicates a chunk.
          this.entryCursors.push({
            streamId: input.streamId,
            cursor: stream.cursor
          });
          for (let i = stream.cursor; i < input.total; i++) {
            stream.append({ i });
            this.produced.push(`${input.streamId}:${i}`);
          }
          stream.close();
          return { streamId: input.streamId, cursor: input.total };
        });
      }
    }
  });

  readonly lifecycle = Lifecycle.install(this)
    .use(this.streams)
    .use(this.tasks);
}
