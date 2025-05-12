import type { Agent } from "../../dist";
import type { env } from "cloudflare:workers";
import { useAgent } from "../react";

declare class A extends Agent<typeof env, {}> {
  prop: string;
  fn: () => number;
}

const a1 = useAgent<{}>({
  agent: "test",
});

// ensure retro-compatibility with useAgent<State> API
a1.call("fn");
a1.call("fn", [1]);
a1.call("fn", [1], { onDone: () => {} });
