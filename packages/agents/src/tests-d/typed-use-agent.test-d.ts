import type { env } from "cloudflare:workers";
import { Agent } from "..";
import { useAgent } from "../react";

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
  nonSerializableParams: (a: string, b: { c: Date }) => void;
  nonSerializableReturn: (a: string) => Date;
}

// @ts-expect-error state doesn't match type A state
const _a2 = useAgent<A, { foo: "bar" }>({
  agent: "test"
});

const a1 = useAgent<A, {}>({
  agent: "test"
});

a1.call("f1") satisfies Promise<number>;
// @ts-expect-error
a1.call("f1", [1]) satisfies Promise<number>;

a1.call("f2", ["test"]) satisfies Promise<void>;
// @ts-expect-error should receive a [string]
a1.call("f2");
// @ts-expect-error
a1.call("f2", [1]);

a1.call("f3", [1, "test"]) satisfies Promise<string>;
// @ts-expect-error should receive a [number, string]
a1.call("f3") satisfies Promise<string>;
// @ts-expect-error
a1.call("f3", [1]) satisfies Promise<string>;

a1.call("f4") satisfies Promise<void>;
a1.call("f4", []) satisfies Promise<void>;
a1.call("f4", [undefined]) satisfies Promise<void>;

a1.call("f5") satisfies Promise<void>;
// @ts-expect-error should receive a [string | undefined]
a1.call("f5", []) satisfies Promise<void>;
a1.call("f5", [undefined]) satisfies Promise<void>;

a1.call("f6") satisfies Promise<void>;

// @ts-expect-error should receive a [string | undefined, number]
a1.call("f7") satisfies Promise<void>;
a1.call("f7", [undefined, 1]) satisfies Promise<void>;

a1.call("f8") satisfies Promise<void>;
a1.call("f8", [undefined, undefined]) satisfies Promise<void>;

// @ts-expect-error Date parameter not serializable
a1.call("nonSerializableParams", ["test", { c: new Date() }]);
// @ts-expect-error Date return not serializable
a1.call("nonSerializableReturn", ["test"]);
