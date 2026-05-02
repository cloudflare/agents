import type { env } from "cloudflare:workers";
import { Agent } from "..";
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
  f7: (a: string | undefined, b: number) => Promise<void>;
  f8: (a: string | undefined, b?: number) => Promise<void>;
  streamText: (stream: StreamingResponse, prompt: string) => Promise<void>;
  streamNoArgs: (stream: StreamingResponse) => void;
  streamOptional: (stream: StreamingResponse, prompt?: string) => void;
  streamNonSerializableParams: (stream: StreamingResponse, date: Date) => void;
  nonSerializableParams: (a: string, b: { c: Date }) => void;
  nonSerializableReturn: (a: string) => Date;
}

const client = new AgentClient<A, {}>({
  agent: "test",
  host: "localhost"
});

// state should be typed as State | undefined
client.state satisfies {} | undefined;

client.call("f1") satisfies Promise<number>;
// @ts-expect-error
client.call("f1", [1]) satisfies Promise<number>;

client.call("f2", ["test"]) satisfies Promise<void>;
// @ts-expect-error should receive a [string]
client.call("f2");
// @ts-expect-error
client.call("f2", [1]);

client.call("f3", [1, "test"]) satisfies Promise<string>;
// @ts-expect-error should receive a [number, string]
client.call("f3") satisfies Promise<string>;
// @ts-expect-error
client.call("f3", [1]) satisfies Promise<string>;

client.call("f4") satisfies Promise<void>;
client.call("f4", []) satisfies Promise<void>;
client.call("f4", [undefined]) satisfies Promise<void>;

client.call("f5") satisfies Promise<void>;
// @ts-expect-error should receive a [string | undefined]
client.call("f5", []) satisfies Promise<void>;
client.call("f5", [undefined]) satisfies Promise<void>;

client.call("f6") satisfies Promise<void>;

// @ts-expect-error should receive a [string | undefined, number]
client.call("f7") satisfies Promise<void>;
client.call("f7", [undefined, 1]) satisfies Promise<void>;

client.call("f8") satisfies Promise<void>;
client.call("f8", [undefined, undefined]) satisfies Promise<void>;

client.call("streamText", ["hello"], {
  stream: { onChunk: () => {}, onDone: () => {}, onError: () => {} }
}) satisfies Promise<void>;
// @ts-expect-error StreamingResponse is injected server-side
client.call("streamText", [undefined, "hello"]);
client.call("streamNoArgs", undefined, {
  stream: { onChunk: () => {} }
}) satisfies Promise<void>;
client.call("streamOptional") satisfies Promise<void>;
client.call("streamOptional", ["hello"]) satisfies Promise<void>;
// @ts-expect-error Date parameter after StreamingResponse is not serializable
client.call("streamNonSerializableParams", [new Date()]);

// @ts-expect-error Date parameter not serializable — excluded from typed call
client.call("nonSerializableParams", ["test", { c: new Date() }]);
// @ts-expect-error Date return not serializable — excluded from typed call
client.call("nonSerializableReturn", ["test"]);
