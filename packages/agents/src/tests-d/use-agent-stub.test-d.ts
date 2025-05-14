import { Agent } from "..";
import type { env } from "cloudflare:workers";
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

const { stub } = useAgent<A, {}>({
  agent: "test",
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

// @ts-expect-error should not have base Agent methods
stub.setState({ prop: "test" });
