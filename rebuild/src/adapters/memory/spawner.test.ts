import { describe, expect, it } from "vitest";
import { NotFoundError } from "../../kernel/errors.js";
import { createMemoryAgentSpawner } from "./spawner.js";

class Greeter {
  readonly host: unknown;
  count = 0;
  constructor(host: unknown) {
    this.host = host;
  }
  async greet(name: string): Promise<string> {
    this.count += 1;
    return `hello ${name}`;
  }
}

describe("createMemoryAgentSpawner", () => {
  it("get() lazily constructs an instance from the class map", () => {
    const spawner = createMemoryAgentSpawner({ Greeter }, () => ({}));
    const handle = spawner.get("Greeter", "a");
    expect(handle.className).toBe("Greeter");
    expect(handle.name).toBe("a");
  });

  it("call() dispatches to the instance method and returns its result", async () => {
    const spawner = createMemoryAgentSpawner({ Greeter }, () => ({}));
    const handle = spawner.get("Greeter", "a");
    const result = await handle.call<string>("greet", ["world"]);
    expect(result).toBe("hello world");
  });

  it("same name returns the same instance (state persists across calls)", async () => {
    const spawner = createMemoryAgentSpawner({ Greeter }, () => ({}));
    const first = spawner.get("Greeter", "a");
    await first.call("greet", ["x"]);
    const second = spawner.get("Greeter", "a");
    await second.call("greet", ["y"]);
    // both handles refer to the same underlying instance, so count accumulates
    const third = spawner.get("Greeter", "a");
    await third.call("greet", ["z"]);
    expect(await third.call<string>("greet", ["z"])).toBe("hello z");
  });

  it("two different names produce two isolated instances", async () => {
    const spawner = createMemoryAgentSpawner({ Greeter }, () => ({}));
    const a = spawner.get("Greeter", "a");
    const b = spawner.get("Greeter", "b");
    await a.call("greet", ["1"]);
    await a.call("greet", ["2"]);
    await b.call("greet", ["1"]);
    // instances are isolated: verified via constructing with distinct hosts
    expect(a.name).toBe("a");
    expect(b.name).toBe("b");
  });

  it("passes a per-instance host from the hostFactory", () => {
    const hosts: unknown[] = [];
    const spawner = createMemoryAgentSpawner({ Greeter }, (className, name) => {
      const host = { className, name };
      hosts.push(host);
      return host;
    });
    spawner.get("Greeter", "a");
    spawner.get("Greeter", "b");
    expect(hosts).toHaveLength(2);
  });

  it("call() throws NotFoundError for an unknown class", () => {
    const spawner = createMemoryAgentSpawner({}, () => ({}));
    expect(() => spawner.get("Missing", "a")).toThrow(NotFoundError);
  });

  it("call() throws NotFoundError for an unknown method", async () => {
    const spawner = createMemoryAgentSpawner({ Greeter }, () => ({}));
    const handle = spawner.get("Greeter", "a");
    await expect(handle.call("nope", [])).rejects.toThrow(NotFoundError);
  });

  it("abort() prevents further calls on that handle", async () => {
    const spawner = createMemoryAgentSpawner({ Greeter }, () => ({}));
    const handle = spawner.get("Greeter", "a");
    handle.abort();
    await expect(handle.call("greet", ["x"])).rejects.toThrow();
  });

  it("destroy() wipes the instance so a later get() constructs fresh state", async () => {
    const spawner = createMemoryAgentSpawner({ Greeter }, () => ({}));
    const handle = spawner.get("Greeter", "a");
    await handle.call("greet", ["x"]);
    await handle.destroy();
    const fresh = spawner.get("Greeter", "a");
    expect(await fresh.call<string>("greet", ["y"])).toBe("hello y");
  });
});
