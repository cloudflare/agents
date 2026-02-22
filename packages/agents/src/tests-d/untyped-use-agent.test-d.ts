import type { env } from "cloudflare:workers";
import { Agent } from "..";
import { useAgent } from "../react";

declare class A extends Agent<typeof env, {}> {
  prop: string;
  fn: () => number;
  nonSerializableParams: (a: string, b: { c: Date }) => void;
  nonSerializableReturn: (a: string) => Date;
}

const a1 = useAgent<{}>({
  agent: "test"
});

// ensure retro-compatibility with useAgent<State> API
a1.call("fn");
a1.call("fn", [1]);
a1.call("fn", [1], { onDone: () => {} });
a1.call("nonSerializableParams", [
  "test",
  { c: new Date(), unexistent: "property" }
]);
a1.call("nonSerializableReturn", []);
