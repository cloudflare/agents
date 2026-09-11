import { describe, expect, it } from "vitest";
import { parentStub } from "./helpers";

/**
 * DynamicAgents on a plain Durable Object: spawning children, their
 * identity, storage isolation, and the registry.
 */
describe("DynamicAgents on a plain Durable Object", () => {
  it("spawns a child whose own startup observes its identity", async () => {
    const name = crypto.randomUUID();
    const parent = parentStub(name);

    const identity = await parent.spawn("notes");

    expect(identity.isChild).toBe(true);
    expect(identity.name).toBe("notes");
    expect(identity.parentPath).toEqual([
      { className: "DynamicParentObject", name }
    ]);
    // The host's `onStart` ran after the bootstrap message set the identity.
    expect(identity.startedAs).toEqual({
      isChild: true,
      name: "notes",
      parentPath: [{ className: "DynamicParentObject", name }]
    });
  });

  it("is idempotent and keeps each child's storage separate", async () => {
    const parent = parentStub(crypto.randomUUID());

    expect(await parent.increment("a")).toBe(1);
    expect(await parent.increment("a")).toBe(2);
    expect(await parent.increment("b")).toBe(1);
    expect(await parent.list()).toEqual(["a", "b"]);
    expect(await parent.has("a")).toBe(true);
    expect(await parent.has("missing")).toBe(false);
  });

  it("nests: a child spawns a grandchild with the full path", async () => {
    const name = crypto.randomUUID();
    const parent = parentStub(name);

    const identity = await parent.spawnGrandchild("mid", "leaf");

    expect(identity.parentPath).toEqual([
      { className: "DynamicParentObject", name },
      { className: "DynamicChildObject", name: "mid" }
    ]);
    expect(identity.startedAs?.isChild).toBe(true);
    expect(identity.name).toBe("leaf");
  });

  it("keeps the parent itself a root", async () => {
    const parent = parentStub(crypto.randomUUID());
    await parent.spawn("x");
    // Root-side state is reachable without any child context.
    expect(await parent.keepAliveHolds()).toBe(0);
    expect(await parent.leaseRows()).toEqual([]);
  });
});
