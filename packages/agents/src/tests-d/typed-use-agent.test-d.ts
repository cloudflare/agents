import type { Agent } from "../..";
import { env } from "cloudflare:workers";
import { useAgent } from "../react";

declare class A extends Agent<typeof env, {}> {
  prop: string;
  f1: () => number;
  f2: (a: string) => void;
  f3: (a: number, b: string) => Promise<string>;
  f4: (a?: string) => void;
  f5: (a: string | undefined) => void;
  f6: () => Promise<void>;
}

// @ts-expect-error state doesn't match type A state
const a2 = useAgent<A, { foo: 'bar' }>({
  agent: 'test',
});

const a1 = useAgent<A, {}>({
  agent: 'test',
});

a1.call('f1') satisfies Promise<number>;
// @ts-expect-error
a1.call('f1', [1]) satisfies Promise<number>;

a1.call('f2', ['test']) satisfies Promise<void>;
// @ts-expect-error should receive a [string]
a1.call('f2');
// @ts-expect-error
a1.call('f2', [1]);

a1.call('f3', [1, 'test']) satisfies Promise<string>;
// @ts-expect-error should receive a [number, string]
a1.call('f3') satisfies Promise<string>;
// @ts-expect-error
a1.call('f3', [1]) satisfies Promise<string>;

a1.call('f4') satisfies Promise<void>;
a1.call('f4', []) satisfies Promise<void>;
a1.call('f4', [undefined]) satisfies Promise<void>;

a1.call('f5') satisfies Promise<void>;
// @ts-expect-error should receive a [string | undefined]
a1.call('f5', []) satisfies Promise<void>;
a1.call('f5', [undefined]) satisfies Promise<void>;

a1.call('f6') satisfies Promise<void>;
