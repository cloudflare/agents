import { unstable_callable, Agent, type StreamingResponse } from "agents-sdk";
import type { Env } from "../server";

export class Rpc extends Agent<Env> {
  @unstable_callable({
    description: "rpc test",
  })
  async test() {
    return "Hello, world!";
  }

  @unstable_callable({
    description: "rpc test streaming",
    streaming: true,
  })
  async testStreaming(stream: StreamingResponse) {
    for (let i = 0; i < 10; i++) {
      stream.send(`Hello, world! ${i}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    stream.end("Done");
  }
}
