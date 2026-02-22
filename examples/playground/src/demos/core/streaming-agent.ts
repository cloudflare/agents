import { callable, type StreamingResponse } from "agents";
import { PlaygroundAgent as Agent } from "../../shared/playground-agent";

export class StreamingAgent extends Agent<Env, {}> {
  @callable({ streaming: true, description: "Stream numbers from 1 to N" })
  streamNumbers(stream: StreamingResponse, count: number) {
    for (let i = 1; i <= count; i++) {
      stream.send({ number: i, progress: `${i}/${count}` });
    }
    stream.end({ total: count, message: "Stream complete" });
  }

  @callable({ streaming: true, description: "Stream with delays" })
  async streamWithDelay(
    stream: StreamingResponse,
    chunks: string[],
    delayMs: number
  ) {
    for (const chunk of chunks) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      stream.send({ chunk, timestamp: Date.now() });
    }
    stream.end({ chunksDelivered: chunks.length });
  }

  @callable({ streaming: true, description: "Stream that ends with error" })
  streamWithError(stream: StreamingResponse, errorAfter: number) {
    for (let i = 1; i <= errorAfter; i++) {
      stream.send({ number: i });
    }
    stream.end({ error: "Intentional error for testing" });
  }

  @callable({ streaming: true, description: "Stream a countdown" })
  async countdown(stream: StreamingResponse, from: number) {
    for (let i = from; i >= 0; i--) {
      stream.send({ count: i, label: i === 0 ? "Liftoff!" : `${i}...` });
      if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    stream.end({ launched: true });
  }
}
