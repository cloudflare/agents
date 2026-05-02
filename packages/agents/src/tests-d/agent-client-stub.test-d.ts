import type { env } from "cloudflare:workers";
import { Agent, callable } from "..";
import { AgentClient } from "../client";
import type { StreamingResponse } from "../index";

declare class A extends Agent<typeof env, {}> {
  prop: string;
  f1: () => number;
  f2: (a: string) => void;
  f3: (a: number, b: string) => Promise<string>;
  f4: (a?: string) => void;
  f5: (a: string | undefined) => void;
  f6: () => Promise<void>;
  streamText: (stream: StreamingResponse, prompt: string) => Promise<void>;
  streamNoArgs: (stream: StreamingResponse) => void;
  streamOptional: (stream: StreamingResponse, prompt?: string) => void;
  streamNonSerializableParams: (stream: StreamingResponse, date: Date) => void;
  nonSerializableParams: (a: string, b: { c: Date }) => void;
  nonSerializableReturn: (a: string) => Date;
}

const { stub } = new AgentClient<A, {}>({
  agent: "test",
  host: "localhost"
});

stub.f1() satisfies Promise<number>;
// @ts-expect-error
stub.f1(1) satisfies Promise<number>;

stub.f2("test") satisfies Promise<void>;
// @ts-expect-error should receive a [string]
stub.f2();
// @ts-expect-error
stub.f2(1);

stub.f3(1, "test") satisfies Promise<string>;
// @ts-expect-error should receive a [number, string]
stub.f3() satisfies Promise<string>;
// @ts-expect-error
stub.f3(1) satisfies Promise<string>;

stub.f4() satisfies Promise<void>;
stub.f4() satisfies Promise<void>;
stub.f4(undefined) satisfies Promise<void>;

// @ts-expect-error should receive a [string | undefined]
stub.f5() satisfies Promise<void>;
stub.f5(undefined) satisfies Promise<void>;

stub.f6() satisfies Promise<void>;

stub.streamText("hello") satisfies Promise<void>;
// @ts-expect-error StreamingResponse is injected server-side
stub.streamText(undefined, "hello");
stub.streamNoArgs() satisfies Promise<void>;
stub.streamOptional() satisfies Promise<void>;
stub.streamOptional("hello") satisfies Promise<void>;
// @ts-expect-error Date parameter after StreamingResponse is not serializable
stub.streamNonSerializableParams(new Date());

// @ts-expect-error should not have base Agent methods
stub.setState({ prop: "test" });

// @ts-expect-error Date parameter not serializable
stub.nonSerializableParams("test", { c: new Date() });
// @ts-expect-error Date return not serializable
stub.nonSerializableReturn("test");

// Backward compat: untyped client
const untypedClient = new AgentClient({
  agent: "test",
  host: "localhost"
});

untypedClient.call("anyMethod");
untypedClient.call("anyMethod", [1, 2, 3]);
untypedClient.stub.anyMethod("arg1", 123);

// Backward compat: state-only generic (no agent type)
const stateClient = new AgentClient<unknown, { count: number }>({
  agent: "test",
  host: "localhost",
  onStateUpdate: (state) => {
    state.count satisfies number;
  }
});
stateClient.call("anyMethod");
stateClient.stub.anyMethod("arg1");

// Backward compat: state as first generic (pre-existing pattern)
const legacyClient = new AgentClient<{ count: number }>({
  agent: "test",
  host: "localhost",
  onStateUpdate: (state) => {
    state.count satisfies number;
  }
});
legacyClient.call("anyMethod");
legacyClient.stub.anyMethod("arg1");

// Agent type infers state
class MyAgent extends Agent<typeof env, { count: number; name: string }> {
  @callable()
  sayHello(name?: string): string {
    return `Hello, ${name ?? "World"}!`;
  }

  @callable()
  async perform(_task: string, _p1?: number): Promise<void> {}

  nonRpc(): void {}
}

const typedClient = new AgentClient<MyAgent>({
  agent: "my-agent",
  host: "localhost",
  onStateUpdate: (state) => {
    state.count satisfies number;
    state.name satisfies string;
  }
});

typedClient.stub.sayHello() satisfies Promise<string>;
// @ts-expect-error first argument is not a string
await typedClient.stub.sayHello(1);
await typedClient.stub.perform("some task", 1);
await typedClient.stub.perform("another task");
// @ts-expect-error requires parameters
await typedClient.stub.perform();
