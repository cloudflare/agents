import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "../../lifecycle";
import { Streams } from "../../streams";
import { Tasks, type TaskInterruption, type TaskStep } from "../../tasks";

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
 * Streams and Tasks composed on one Lifecycle, exercising the contract the
 * RFC names: a task step appends to a stream it does not own and
 * checkpoints the cursor; its `recover` callback reads `streams.status()`
 * as interruption evidence and finalizes from it. Neither capability
 * imports the other.
 */
export class TaskStreamComposeObject extends DurableObject<Cloudflare.Env> {
  /** Chunk producers that actually executed (journal hits never append). */
  readonly produced: string[] = [];
  /** Evidence observed by the recover callback. */
  readonly recoveryEvidence: Array<{
    step: string | null;
    streamState: string | null;
    streamCursor: number;
    checkpointCursor: number;
  }> = [];

  readonly streams = new Streams();

  readonly tasks = new Tasks({
    definitions: {
      generate: {
        run: async (
          input: { streamId: string; total: number },
          step: TaskStep
        ) => {
          return step.do("stream", async ({ checkpoint }) => {
            const stream = await this.streams.open(input.streamId);
            // Resuming producers start from the stream's own cursor, so a
            // replay after interruption never duplicates a chunk.
            for (let i = stream.cursor; i < input.total; i++) {
              stream.append({ i });
              this.produced.push(`${input.streamId}:${i}`);
              checkpoint({ streamId: input.streamId, cursor: stream.cursor });
            }
            stream.close();
            return { streamId: input.streamId, cursor: input.total };
          });
        },
        recover: async (
          interruption: TaskInterruption<{ streamId: string; total: number }>
        ) => {
          const checkpoint = (interruption.interruptedStep?.checkpoint ??
            null) as { streamId: string; cursor: number } | null;
          if (!checkpoint) return { action: "replay" as const };

          // The stream's durable status is the recovery evidence: exactly
          // the chunks that were appended before the process died.
          const status = await this.streams.status(checkpoint.streamId);
          this.recoveryEvidence.push({
            step: interruption.interruptedStep?.name ?? null,
            streamState: status?.state ?? null,
            streamCursor: status?.cursor ?? -1,
            checkpointCursor: checkpoint.cursor
          });

          const writer = await this.streams.open(checkpoint.streamId);
          writer.close();
          return {
            action: "complete" as const,
            result: {
              streamId: checkpoint.streamId,
              cursor: status?.cursor ?? 0
            }
          };
        }
      }
    }
  });

  readonly lifecycle = Lifecycle.install(this)
    .use(this.streams)
    .use(this.tasks);
}
