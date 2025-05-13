import type { Agent } from "../../dist";
import type { env } from "cloudflare:workers";
import { useAgent } from "../react";

declare class A extends Agent<typeof env, {}> {
  prop: string;
  fn: () => number;
}

const { stub } = useAgent<{}>({
  agent: "test",
});

// ensure retro-compatibility with useAgent<State> API
stub.fn();
stub.fn(1);
stub.fn(1);

// no type checking on the stub
stub.foo(1, "bar");
