import type { env } from "cloudflare:workers";
import { Agent, callable } from "..";
import { useAgent } from "../react.tsx";

class MyAgent extends Agent<typeof env, {}> {
  @callable()
  sayHello(name?: string): string {
    return `Hello, ${name ?? "World"}!`;
  }

  @callable()
  async perform(_task: string, _p1?: number): Promise<void> {
    // do something
  }

  // not decorated with @callable()
  nonRpc(): void {
    // do something
  }
}

const agent = useAgent<MyAgent, {}>({ agent: "my-agent" });
// return type is promisified
agent.call("sayHello") satisfies Promise<string>;

// @ts-expect-error first argument is not a string
await agent.call("sayHello", [1]);

await agent.call("perform", ["some task", 1]);
await agent.call("perform", ["another task"]);
// @ts-expect-error requires parameters
await agent.call("perform");

// we cannot exclude it because typescript doesn't have a way
// to exclude based on decorators
await agent.call("nonRpc");

// @ts-expect-error nonSerializable is not serializable
await agent.call("nonSerializable", ["hello", new Date()]);

const agent2 = useAgent<Omit<MyAgent, "nonRpc">, {}>({ agent: "my-agent" });
agent2.call("sayHello");
// @ts-expect-error nonRpc excluded from useAgent
agent2.call("nonRpc");
