import type { env } from "cloudflare:workers";
import { unstable_callable as callable, Agent } from "../index.ts";
import { useAgent } from "../react.tsx";

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
  nonRpc(): void {}
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

const { stub: stub2 } = useAgent<Omit<MyAgent, "nonRpc">, {}>({
  agent: "my-agent",
});
stub2.sayHello();
// @ts-expect-error nonRpc excluded from useAgent
stub2.nonRpc();
