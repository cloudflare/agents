import { describe, expect, it } from "vitest";
import { createMemoryAgentSpawner } from "../../adapters/memory/spawner.js";
import { createMemoryKeyValueStore } from "../../adapters/memory/store.js";
import { createTestClock } from "../../adapters/memory/clock.js";
import { defaultIdSource } from "../../kernel/ids.js";
import { ValidationError } from "../../kernel/errors.js";
import { createSubAgentRegistry } from "./registry.js";

class Facet {
  readonly host: unknown;
  calls = 0;
  constructor(host: unknown) {
    this.host = host;
  }
  async ping(): Promise<string> {
    this.calls += 1;
    return "pong";
  }
  async getSelfPath(): Promise<unknown> {
    return (this.host as { selfPath?: unknown }).selfPath;
  }
}

class Widget {
  constructor(readonly host: unknown) {}
}

function harness() {
  const store = createMemoryKeyValueStore();
  const clock = createTestClock(1_000);
  const hosts: Array<{ className: string; name: string }> = [];
  const spawner = createMemoryAgentSpawner({ Facet, Widget }, (className, name) => {
    const host = { className, name };
    hosts.push(host);
    return host;
  });
  const registry = createSubAgentRegistry({ store, spawner, clock, ids: defaultIdSource });
  return { store, clock, spawner, hosts, registry };
}

describe("createSubAgentRegistry", () => {
  it("get() lazily creates on first access and records a registry row", () => {
    const { registry, clock } = harness();
    expect(registry.has("Facet", "a")).toBe(false);

    const handle = registry.get("Facet", "a");

    expect(handle.className).toBe("Facet");
    expect(handle.name).toBe("a");
    expect(registry.has("Facet", "a")).toBe(true);
    expect(registry.list()).toEqual([{ className: "Facet", name: "a", createdAt: clock.now() }]);
  });

  it("get() is idempotent: a second call returns a handle to the same instance without re-registering", async () => {
    const { registry, clock } = harness();
    registry.get("Facet", "a");
    clock.advance(500);
    const second = registry.get("Facet", "a");
    await second.call("ping", []);

    const rows = registry.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.createdAt).toBe(1_000); // unchanged by the second get()

    // same underlying instance: state accumulates across handles
    expect(await registry.get("Facet", "a").call<string>("ping", [])).toBe("pong");
  });

  it("list() returns rows in creation order, optionally filtered by className", () => {
    const { registry, clock } = harness();
    registry.get("Facet", "b");
    clock.advance(10);
    registry.get("Facet", "a");
    clock.advance(10);
    registry.get("Widget", "z");

    const all = registry.list();
    expect(all.map((r) => `${r.className}:${r.name}`)).toEqual(["Facet:b", "Facet:a", "Widget:z"]);

    const facetsOnly = registry.list("Facet");
    expect(facetsOnly.map((r) => r.name)).toEqual(["b", "a"]);
  });

  it("delete() removes the registry row and destroys the child instance; idempotent", async () => {
    const { registry, spawner } = harness();
    const handle = registry.get("Facet", "a");
    await handle.call("ping", []);

    await registry.delete("Facet", "a");

    expect(registry.has("Facet", "a")).toBe(false);
    expect(registry.list()).toEqual([]);

    // destroyed: a fresh get() constructs new state
    const fresh = spawner.get("Facet", "a");
    expect(await fresh.call<string>("ping", [])).toBe("pong");

    // idempotent: deleting again (and deleting a name that was never created) does not throw
    await expect(registry.delete("Facet", "a")).resolves.toBeUndefined();
    await expect(registry.delete("Widget", "never-created")).resolves.toBeUndefined();
  });

  it("abort() aborts the handle but keeps the registry row (storage kept)", async () => {
    const { registry } = harness();
    const handle = registry.get("Facet", "a");

    registry.abort("Facet", "a", "shutting down");

    expect(registry.has("Facet", "a")).toBe(true);
    await expect(handle.call("ping", [])).rejects.toThrow();
  });

  it("rejects a class name that kebab-cases to the reserved word \"sub\"", () => {
    const { registry } = harness();
    expect(() => registry.get("sub", "a")).toThrow(ValidationError);
    expect(() => registry.get("Sub", "a")).toThrow(ValidationError);
  });

  it("class names that merely contain \"sub\" as a substring are allowed", () => {
    const { store, clock, spawner } = harness();
    const registry2 = createSubAgentRegistry({
      store,
      spawner: createMemoryAgentSpawner({ SubAgent: Facet, MySub: Facet }, () => ({})),
      clock,
      ids: defaultIdSource,
    });
    expect(() => registry2.get("SubAgent", "a")).not.toThrow();
    expect(() => registry2.get("MySub", "a")).not.toThrow();
    void store;
  });

  it("propagates parentPath to the spawned child via the in-memory spawner's construction options", async () => {
    const store = createMemoryKeyValueStore();
    const clock = createTestClock();
    const parentPath = [{ className: "Root", name: "root-1" }];
    const spawner = createMemoryAgentSpawner({ Facet }, (className, name) => ({
      parentPath,
      selfPath: [...parentPath, { className, name }],
    }));
    const registry = createSubAgentRegistry({ store, spawner, clock, ids: defaultIdSource });

    const handle = registry.get("Facet", "child-1");
    const selfPath = await handle.call("getSelfPath", []);

    expect(selfPath).toEqual([{ className: "Root", name: "root-1" }, { className: "Facet", name: "child-1" }]);
  });
});
