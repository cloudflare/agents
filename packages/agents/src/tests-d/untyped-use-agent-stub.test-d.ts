import type { env } from "cloudflare:workers";
import { Agent } from "..";
import { useAgent } from "../react";

declare class A extends Agent<typeof env, {}> {
  prop: string;
  fn: () => number;
  nonSerializableParams: (a: string, b: { c: Date }) => void;
  nonSerializableReturn: (a: string) => Date;
}

const { stub } = useAgent<{}>({
  agent: "test"
});

// ensure retro-compatibility with useAgent<State> API
stub.fn();
stub.fn(1);
stub.foo(1, "bar");
stub.nonSerializableParams("test", { c: new Date(), unexistent: "property" });
stub.nonSerializableReturn("test");
