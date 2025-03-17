import {
  unstable_callable as callable,
  Agent,
  type StreamingResponse,
} from "agents";
import type { Env } from "../server";

export class Rpc extends Agent<Env> {
  @callable()
  async test() {
    return "Hello, world!";
  }

  @callable({ streaming: true })
  async testStreaming(stream: StreamingResponse) {
    for (let i = 0; i < 10; i++) {
      stream.send(`Hello, world! ${i}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    stream.end("Done");
  }
}
