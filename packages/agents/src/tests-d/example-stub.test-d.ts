/** biome-ignore-all lint/correctness/useHookAtTopLevel: testing types */
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

// Test case for issue #598: callable returning this.state
type MyState = { count: number; name: string };

class AgentWithState extends Agent<typeof env, MyState> {
  // Explicit return type annotation - this should work
  @callable()
  async getInternalExplicit(): Promise<MyState> {
    return this.state;
  }

  // No explicit return type - TypeScript infers the return type
  // This is the case reported in issue #598
  @callable()
  async getInternal() {
    return this.state;
  }

  @callable()
  getInternalSync() {
    return this.state;
  }
}

// Test with default unknown state - this is the case reported in issue #598
class AgentWithUnknownState extends Agent<typeof env> {
  @callable()
  async getInternal() {
    return this.state;
  }
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

// @ts-expect-error nonSerializable is not serializable
await stub.nonSerializable("hello", new Date());

const { stub: stub2 } = useAgent<Omit<MyAgent, "nonRpc">, {}>({
  agent: "my-agent"
});
stub2.sayHello();
// @ts-expect-error nonRpc excluded from useAgent
stub2.nonRpc();

// Test case for https://github.com/cloudflare/agents/issues/598
const { stub: stubWithState } = useAgent<AgentWithState, MyState>({
  agent: "agent-with-state"
});

// These should work without TypeScript errors
stubWithState.getInternalExplicit() satisfies Promise<MyState>;
stubWithState.getInternal() satisfies Promise<MyState>;
stubWithState.getInternalSync() satisfies Promise<MyState>;

// Test with unknown state
const { stub: stubUnknown } = useAgent<AgentWithUnknownState, unknown>({
  agent: "agent-unknown"
});
stubUnknown.getInternal() satisfies Promise<unknown>;
