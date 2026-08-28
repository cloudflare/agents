import { DurableObject } from "cloudflare:workers";
import { Lifecycle, type DurableObjectCapability } from "../lifecycle";
import {
  Streams,
  StreamClosedError,
  type StreamChunk,
  type StreamStatus,
  type StreamWriter
} from "../streams";

class ReportObject extends DurableObject {
  readonly streams = new Streams({ maxChunkBytes: 65536 });
  readonly lifecycle = Lifecycle.install(this).use(this.streams);
}

declare const object: ReportObject;
object.streams satisfies DurableObjectCapability;

object.streams.open("reply:1", {
  metadata: { topic: "demo" }
}) satisfies Promise<StreamWriter>;
object.streams.status("reply:1") satisfies Promise<StreamStatus | null>;
object.streams.delete("reply:1") satisfies Promise<boolean>;

declare const writer: StreamWriter;
writer.append({ text: "chunk" }) satisfies number;
writer.cursor satisfies number;
writer.close() satisfies void;
writer.error("boom") satisfies void;
// @ts-expect-error chunks must be JSON values.
writer.append(() => {});

// read() is an async iterable of sequenced chunks.
async function consume(): Promise<void> {
  for await (const chunk of object.streams.read("reply:1", { from: 2 })) {
    chunk satisfies StreamChunk;
    chunk.seq satisfies number;
  }
}
void consume;

new StreamClosedError("reply:1", "settled") satisfies Error;
