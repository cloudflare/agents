/** biome-ignore-all lint/correctness/useHookAtTopLevel: testing types */
import type { env } from "cloudflare:workers";
import { Agent, callable, type StreamingResponse } from "..";
import { useAgent } from "../react.tsx";

class MyAgent extends Agent<typeof env, {}> {
  @callable()
  sayHello(name?: string): string {
    return `Hello, ${name ?? "World"}!`;
  }

  @callable()
  async perform(_task: string, _p1?: number): Promise<void> {
    // do something
  }

  // not decorated with @callable()
  nonRpc(): void {
    // do something
  }

  @callable({ streaming: true })
  performStream(
    _options: StreamingResponse<number, boolean>,
    _other: string
  ): void {
    // do something
  }

  // TODO should fail, first argument is not a streamOptions
  @callable({ streaming: true })
  performStreamFirstArgNotStreamOptions(
    _other: string,
    _options: StreamingResponse<number, boolean>
  ): void {
    // do something
  }

  // TODO should fail, should be marked as streaming
  @callable()
  performStreamFail(_options: StreamingResponse): void {
    // do something
  }

  // TODO should fail, has no streamOptions
  @callable({ streaming: true })
  async performFail(_task: string): Promise<string> {
    // do something
    return "";
  }

  @callable({ streaming: true })
  performStreamUnserializable(options: StreamingResponse<Date>): void {
    // @ts-expect-error parameter is not serializable
    options.onDone(new Date());
  }
}

const { stub, streamingStub } = useAgent<MyAgent, {}>({ agent: "my-agent" });
// return type is promisified
stub.sayHello() satisfies Promise<string>;

// @ts-expect-error first argument is not a string
await stub.sayHello(1);

await stub.perform("some task", 1);
await stub.perform("another task");
// @ts-expect-error requires parameters
await stub.perform();

// we cannot exclude it because typescript doesn't have a way
// to exclude based on decorators
await stub.nonRpc();

// @ts-expect-error nonSerializable is not serializable
await stub.nonSerializable("hello", new Date());

const generator = streamingStub.performStream("hello") satisfies AsyncGenerator<
  number,
  boolean
>;
for await (const chunk of generator) {
  chunk satisfies number;
}

// @ts-expect-error there's no 2nd argument
streamingStub.performStream("hello", 1);

const { stub: stub2 } = useAgent<Omit<MyAgent, "nonRpc">, {}>({
  agent: "my-agent"
});

stub2.sayHello();
// @ts-expect-error nonRpc excluded from useAgent
stub2.nonRpc();
