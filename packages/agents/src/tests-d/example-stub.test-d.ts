import type { env } from "cloudflare:workers";
import {
  unstable_callable as callable,
  Agent,
  type StreamingResponse,
} from "..";
import { useAgent } from "../react.tsx";
import type { StreamOptions } from "../client.ts";

class MyAgent extends Agent<typeof env, {}> {
  @callable()
  sayHello(name?: string): string {
    return `Hello, ${name ?? "World"}!`;
  }

  @callable()
  async perform(task: string, p1?: number): Promise<void> {
    // do something
  }

  // not decorated with @callable()
  nonRpc(): void {
    // do something
  }

  @callable({ streaming: true })
  performStream(
    options: StreamingResponse<number, boolean>,
    other: string
  ): void {
    // do something
  }

  // TODO should fail, first argument is not a streamOptions
  @callable({ streaming: true })
  performStreamFirstArgNotStreamOptions(
    other: string,
    options: StreamingResponse<number, boolean>
  ): void {
    // do something
  }

  // TODO should fail, should be marked as streaming
  @callable()
  performStreamFail(options: StreamingResponse): void {
    // do something
  }

  // TODO should fail, has no streamOptions
  @callable({ streaming: true })
  async performFail(task: string): Promise<string> {
    // do something
    return "";
  }

  @callable({ streaming: true })
  performStreamUnserializable(options: StreamingResponse<Date>): void {
    // @ts-expect-error parameter is not serializable
    options.onDone(new Date());
  }
}

const { stub } = useAgent<MyAgent, {}>({ agent: "my-agent" });
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

const streamOptions: StreamOptions<number, boolean> = {};

// biome-ignore lint: suspicious/noConfusingVoidType
stub.performStream(streamOptions, "hello") satisfies void;

// @ts-expect-error there's no 2nd argument
stub.performStream(streamOptions, "hello", 1);

const invalidStreamOptions: StreamOptions<string, boolean> = {};

// @ts-expect-error streamOptions must be of type StreamOptions<number, boolean>
stub.performStream(invalidStreamOptions, "hello");

// @ts-expect-error first argument is not a streamOptions
stub.performStreamFirstArgNotStreamOptions("hello", streamOptions);

const { stub: stub2 } = useAgent<Omit<MyAgent, "nonRpc">, {}>({
  agent: "my-agent",
});

stub2.sayHello();
// @ts-expect-error nonRpc excluded from useAgent
stub2.nonRpc();
