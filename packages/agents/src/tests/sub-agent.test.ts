import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "../index";

function uniqueName() {
  return `sub-agent-test-${Math.random().toString(36).slice(2)}`;
}

describe("SubAgent", () => {
  it("should create a sub-agent and call RPC methods on it", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    const result = await agent.subAgentPing("counter-a");
    expect(result).toBe("pong");
  });

  it("should persist data in a sub-agent's own SQLite", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    const v1 = await agent.subAgentIncrement("counter-a", "clicks");
    expect(v1).toBe(1);

    const v2 = await agent.subAgentIncrement("counter-a", "clicks");
    expect(v2).toBe(2);

    const current = await agent.subAgentGet("counter-a", "clicks");
    expect(current).toBe(2);
  });

  it("should isolate storage between different named sub-agents", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    await agent.subAgentIncrement("child-x", "hits");
    await agent.subAgentIncrement("child-x", "hits");
    await agent.subAgentIncrement("child-y", "hits");

    const xHits = await agent.subAgentGet("child-x", "hits");
    const yHits = await agent.subAgentGet("child-y", "hits");

    expect(xHits).toBe(2);
    expect(yHits).toBe(1);
  });

  it("should run multiple sub-agents in parallel", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    const results = await agent.subAgentIncrementMultiple(
      ["parallel-a", "parallel-b", "parallel-c"],
      "counter"
    );

    expect(results).toEqual([1, 1, 1]);
  });

  it("should abort a sub-agent and restart it on next access", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    await agent.subAgentIncrement("resettable", "val");
    const before = await agent.subAgentGet("resettable", "val");
    expect(before).toBe(1);

    // Abort the sub-agent
    await agent.subAgentAbort("resettable");

    // Sub-agent restarts on next access — data persists because
    // abort doesn't delete storage, only kills the running instance
    const after = await agent.subAgentGet("resettable", "val");
    expect(after).toBe(1);

    // Should still be functional after abort+restart
    const incremented = await agent.subAgentIncrement("resettable", "val");
    expect(incremented).toBe(2);
  });

  it("should delete a sub-agent and its storage", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    await agent.subAgentIncrement("deletable", "count");
    await agent.subAgentIncrement("deletable", "count");
    const before = await agent.subAgentGet("deletable", "count");
    expect(before).toBe(2);

    // Delete the sub-agent (kills instance + wipes storage)
    await agent.subAgentDelete("deletable");

    // Re-accessing should create a fresh sub-agent with empty storage
    const after = await agent.subAgentGet("deletable", "count");
    expect(after).toBe(0);
  });

  it("should set this.name to the facet name", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    const childName = await agent.subAgentGetName("my-counter");
    expect(childName).toBe("my-counter");

    const otherName = await agent.subAgentGetName("other-counter");
    expect(otherName).toBe("other-counter");
  });

  it("should throw descriptive error for non-exported sub-agent class", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    const { error } = await agent.subAgentMissingExport();
    expect(error).toMatch(/not found in worker exports/);
  });

  it("should throw descriptive error when the parent class is exported under a different name than its declaration", async () => {
    // The parent's class identifier is `_UnboundParent` but it's
    // exported as `TestUnboundParentAgent`. So `this.constructor.name`
    // inside an instance is `_UnboundParent`, but `ctx.exports` is
    // keyed by the export name (`TestUnboundParentAgent`). The
    // ctx.exports[parentClassName] lookup fails, and we expect a
    // helpful error pointing at the binding requirement.
    const parentName = uniqueName();
    const childName = uniqueName();
    const agent = await getAgentByName(env.TestUnboundParentAgent, parentName);

    const error = await agent.tryToSpawn(childName);
    expect(error).toMatch(
      /Sub-agent bootstrap requires the parent class "_UnboundParent" to be bound/
    );
    expect(error).toMatch(/wrangler\.jsonc durable_objects\.bindings/);
    // Class identifier doesn't look minified — no minification hint.
    expect(error).not.toMatch(/looks minified/);
  });

  it("should hint at minification when the parent class name looks minified", async () => {
    // Same scenario, but the parent's class identifier is `_a` —
    // matches the minification heuristic. The error message should
    // include the bundler hint so users with minified production
    // builds get a helpful pointer.
    const parentName = uniqueName();
    const childName = uniqueName();
    const agent = await getAgentByName(
      env.TestMinifiedNameParentAgent,
      parentName
    );

    const error = await agent.tryToSpawn(childName);
    expect(error).toMatch(/parent class "_a" to be bound/);
    expect(error).toMatch(/looks minified/);
    expect(error).toMatch(/keepNames/);
  });

  it("should allow same name with different classes", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    const { counterPing, callbackLog } =
      await agent.subAgentSameNameDifferentClass("shared-name");
    expect(counterPing).toBe("pong");
    expect(callbackLog).toEqual([]);
  });

  it("should keep parent and sub-agent storage fully isolated", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    // Write to parent's own SQLite
    await agent.writeParentStorage("color", "blue");

    // Write to a sub-agent's SQLite
    await agent.subAgentIncrement("child", "color");

    // Read back both — neither should affect the other
    const parentVal = await agent.readParentStorage("color");
    expect(parentVal).toBe("blue");

    const childVal = await agent.subAgentGet("child", "color");
    expect(childVal).toBe(1);

    // Parent storage should not have the counter table, and
    // sub-agent should not have the parent_kv table.
    // Verify by writing more to each side independently.
    await agent.writeParentStorage("color", "red");
    await agent.subAgentIncrement("child", "color");

    expect(await agent.readParentStorage("color")).toBe("red");
    expect(await agent.subAgentGet("child", "color")).toBe(2);
  });

  describe("RpcTarget callback streaming", () => {
    it("should pass an RpcTarget callback to a sub-agent and receive chunks", async () => {
      const name = uniqueName();
      const agent = await getAgentByName(env.TestSubAgentParent, name);

      const { received, done } = await agent.subAgentStreamViaCallback(
        "streamer-a",
        ["Hello", " ", "world", "!"]
      );

      // Each chunk should be the accumulated text so far
      expect(received).toEqual([
        "Hello",
        "Hello ",
        "Hello world",
        "Hello world!"
      ]);
      expect(done).toBe("Hello world!");
    });

    it("should persist data in the sub-agent after callback streaming", async () => {
      const name = uniqueName();
      const agent = await getAgentByName(env.TestSubAgentParent, name);

      await agent.subAgentStreamViaCallback("streamer-b", ["foo", "bar"]);
      const log = await agent.subAgentGetStreamLog("streamer-b");
      expect(log).toEqual(["foobar"]);
    });

    it("should handle multiple callback streams to the same sub-agent", async () => {
      const name = uniqueName();
      const agent = await getAgentByName(env.TestSubAgentParent, name);

      await agent.subAgentStreamViaCallback("streamer-c", ["first"]);
      await agent.subAgentStreamViaCallback("streamer-c", ["second"]);

      const log = await agent.subAgentGetStreamLog("streamer-c");
      expect(log).toEqual(["first", "second"]);
    });

    it("should isolate callback streaming across sub-agents", async () => {
      const name = uniqueName();
      const agent = await getAgentByName(env.TestSubAgentParent, name);

      await agent.subAgentStreamViaCallback("iso-a", ["alpha"]);
      await agent.subAgentStreamViaCallback("iso-b", ["beta"]);

      expect(await agent.subAgentGetStreamLog("iso-a")).toEqual(["alpha"]);
      expect(await agent.subAgentGetStreamLog("iso-b")).toEqual(["beta"]);
    });

    it("should handle single-chunk callback stream", async () => {
      const name = uniqueName();
      const agent = await getAgentByName(env.TestSubAgentParent, name);

      const { received, done } = await agent.subAgentStreamViaCallback(
        "single",
        ["only-one"]
      );

      expect(received).toEqual(["only-one"]);
      expect(done).toBe("only-one");
    });
  });

  describe("nested sub-agents", () => {
    it("should support sub-agents spawning their own sub-agents", async () => {
      const name = uniqueName();
      const agent = await getAgentByName(env.TestSubAgentParent, name);

      // Write via outer → inner chain
      await agent.nestedSetValue("outer-1", "inner-1", "greeting", "hello");

      // Read it back through the same chain
      const value = await agent.nestedGetValue(
        "outer-1",
        "inner-1",
        "greeting"
      );
      expect(value).toBe("hello");
    });

    it("should isolate nested sub-agent storage", async () => {
      const name = uniqueName();
      const agent = await getAgentByName(env.TestSubAgentParent, name);

      await agent.nestedSetValue("outer-1", "inner-a", "key", "value-a");
      await agent.nestedSetValue("outer-1", "inner-b", "key", "value-b");

      const a = await agent.nestedGetValue("outer-1", "inner-a", "key");
      const b = await agent.nestedGetValue("outer-1", "inner-b", "key");

      expect(a).toBe("value-a");
      expect(b).toBe("value-b");
    });

    it("should call methods on outer sub-agent directly", async () => {
      const name = uniqueName();
      const agent = await getAgentByName(env.TestSubAgentParent, name);

      const result = await agent.nestedPing("outer-1");
      expect(result).toBe("outer-pong");
    });
  });

  it("should throw a clear error when scheduling in a sub-agent", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    const error = await agent.subAgentTrySchedule("sched-guard");
    expect(error).toMatch(/not supported in sub-agents/);
  });

  it("keepAlive() works inside a sub-agent (facets maintain their own alarm heartbeat)", async () => {
    // Regression: earlier versions banned keepAlive on facets, which
    // crashed every streaming turn in an AIChatAgent facet
    // (`_reply` uses `keepAliveWhile` to guard stream commit).
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    const error = await agent.subAgentTryKeepAlive("keepalive-ok");
    expect(error).toBe("");
  });

  it("keepAliveWhile() runs to completion inside a sub-agent", async () => {
    // Mirror AIChatAgent._reply's exact call shape.
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    const result = await agent.subAgentTryKeepAliveWhile("keepalive-while-ok");
    expect(result).toBe("ok");
  });

  describe("parentAgent()", () => {
    it("resolves the parent stub from within a facet", async () => {
      const parentName = uniqueName();
      const parent = await getAgentByName(env.TestSubAgentParent, parentName);

      // Child uses `this.parentAgent(env.TestSubAgentParent)` to
      // open a stub and calls `getOwnName()` on it. The returned
      // name should match the parent's.
      const observed = await parent.subAgentCallParentName("parent-probe");
      expect(observed).toBe(parentName);
    });

    it("throws a clear error when called on a non-facet (top-level agent)", async () => {
      const parentName = uniqueName();
      const parent = await getAgentByName(env.TestSubAgentParent, parentName);

      const err = await parent.tryParentAgent();
      expect(err).toMatch(/not a facet/i);
    });

    it("throws when the passed class doesn't match the recorded parent class", async () => {
      // Regression guard: the previous signature accepted a namespace
      // and would happily resolve a stub for the wrong DO if the
      // caller passed the wrong binding. The class-ref form checks
      // that `cls.name` equals the recorded direct-parent class at
      // runtime.
      const parentName = uniqueName();
      const parent = await getAgentByName(env.TestSubAgentParent, parentName);

      const err =
        await parent.subAgentTryParentAgentWithWrongClass("wrong-class-probe");
      expect(err).toMatch(/parentAgent/);
      expect(err).toMatch(/recorded parent class/i);
      // Both class names should be named in the error so the user
      // can see what went wrong.
      expect(err).toMatch(/CallbackSubAgent/);
      expect(err).toMatch(/TestSubAgentParent/);
    });

    it("resolves the direct parent, not the root, in a doubly-nested chain", async () => {
      // Regression guard for root-vs-direct-parent ordering. The
      // chain is:
      //
      //   TestSubAgentParent (root)
      //     └─ OuterSubAgent
      //          └─ InnerSubAgent (test subject)
      //
      // InnerSubAgent.parentPath is root-first:
      //   [TestSubAgentParent, OuterSubAgent]
      //
      // A naive `parentPath[0]` grabs the root. The fixed
      // implementation uses `parentPath.at(-1)` — the direct parent.
      //
      // We probe this through the class-mismatch error: calling
      // `parentAgent(TestSubAgentParent)` from an Inner facet should
      // throw "recorded parent class is OuterSubAgent" — NOT
      // succeed (which is what would happen if `parentPath[0]` was
      // still being used).
      const rootName = uniqueName();
      const outerName = uniqueName();
      const innerName = uniqueName();
      const root = await getAgentByName(env.TestSubAgentParent, rootName);

      const err = await root.subAgentNestedTryParentAgentWithRoot(
        outerName,
        innerName
      );
      expect(err).toMatch(/parentAgent/);
      expect(err).toMatch(/recorded parent class/i);
      expect(err).toMatch(/OuterSubAgent/);
      // And the class the caller (wrongly) passed is named too.
      expect(err).toMatch(/TestSubAgentParent/);
    });
  });

  it("should throw a clear error when cancelSchedule in a sub-agent", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    const error = await agent.subAgentTryCancelSchedule("cancel-guard");
    expect(error).toMatch(/not supported in sub-agents/);
  });

  it("should preserve the facet flag after abort and re-access", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    // This test aborts the sub-agent (killing the instance) then
    // re-accesses it. The _isFacet flag must survive via storage.
    const error = await agent.subAgentTryScheduleAfterAbort("persist-flag");
    expect(error).toMatch(/not supported in sub-agents/);
  });

  // ── Regression: cross-DO I/O on broadcast paths ─────────────────────
  // Sub-agents share their parent's process but have their own isolate.
  // On production, iterating the connection registry or sending through
  // a parent-owned WebSocket from a facet throws "Cannot perform I/O on
  // behalf of a different Durable Object". The Agent base class guards
  // every broadcast path with `_isFacet` — these tests pin the guards
  // in place so they cannot be regressed away.

  describe("broadcast paths on facets", () => {
    it("should initialize a facet without throwing on first onStart", async () => {
      const name = uniqueName();
      const agent = await getAgentByName(env.TestSubAgentParent, name);

      // The wrapped onStart calls `broadcastMcpServers()` before user
      // code runs. If `_isFacet` is not set before that runs (ordering
      // regression), the broadcast path can throw cross-DO I/O on
      // production. Reaching the `initializedOk()` method at all
      // proves init completed cleanly.
      const ok = await agent.subAgentInitOk("init-clean");
      expect(ok).toBe(true);
    });

    it("should no-op when a sub-agent calls this.broadcast(...)", async () => {
      const name = uniqueName();
      const agent = await getAgentByName(env.TestSubAgentParent, name);

      const error = await agent.subAgentTryBroadcast(
        "broadcaster",
        "hello from facet"
      );
      expect(error).toBe("");
    });

    it("should persist state but skip broadcast when setState is called in a sub-agent", async () => {
      const name = uniqueName();
      const agent = await getAgentByName(env.TestSubAgentParent, name);

      // setState drives `_broadcastProtocol()` under the hood. On a
      // facet the broadcast must be skipped, but the state mutation
      // itself must still succeed (SQL + in-memory update).
      const result = await agent.subAgentTrySetState("stateful", 42, "ping");
      expect(result.error).toBe("");
      expect(result.persistedCount).toBe(42);
      expect(result.persistedMsg).toBe("ping");
    });
  });

  // ── parentPath / selfPath / hasSubAgent / listSubAgents ────────────

  describe("parentPath and registry", () => {
    it("a direct child's parentPath contains just its parent", async () => {
      const parentName = uniqueName();
      const childName = uniqueName();
      const agent = await getAgentByName(env.TestSubAgentParent, parentName);

      const path = await agent.subAgentParentPath(childName);
      expect(path).toEqual([
        { className: "TestSubAgentParent", name: parentName }
      ]);
    });

    it("a direct child's selfPath is parentPath + self", async () => {
      const parentName = uniqueName();
      const childName = uniqueName();
      const agent = await getAgentByName(env.TestSubAgentParent, parentName);

      const path = await agent.subAgentSelfPath(childName);
      expect(path).toEqual([
        { className: "TestSubAgentParent", name: parentName },
        { className: "CounterSubAgent", name: childName }
      ]);
    });

    it("a nested child's parentPath contains the full chain (root-first)", async () => {
      const rootName = uniqueName();
      const outerName = uniqueName();
      const innerName = uniqueName();
      const agent = await getAgentByName(env.TestSubAgentParent, rootName);

      const path = await agent.subAgentNestedParentPath(outerName, innerName);
      expect(path).toEqual([
        { className: "TestSubAgentParent", name: rootName },
        { className: "OuterSubAgent", name: outerName }
      ]);
    });

    it("parentPath survives abort and re-access (persisted in child storage)", async () => {
      const parentName = uniqueName();
      const childName = uniqueName();
      const agent = await getAgentByName(env.TestSubAgentParent, parentName);

      await agent.subAgentParentPath(childName); // warm the child
      await agent.subAgentAbort(childName); // kill the instance

      // Re-fetch. The child's in-memory _parentPath was lost, but
      // `_cf_initAsFacet` persisted `cf_agents_parent_path` to the
      // child's storage and the wrapped `onStart()` rehydrates it on
      // boot. Since `subAgent()` always calls init, it also re-sets
      // _parentPath in-memory on re-access — this test just confirms
      // the result matches across the abort boundary.
      const path = await agent.subAgentParentPath(childName);
      expect(path).toEqual([
        { className: "TestSubAgentParent", name: parentName }
      ]);
    });

    it("hasSubAgent returns true after spawn, false before", async () => {
      const parentName = uniqueName();
      const childName = uniqueName();
      const agent = await getAgentByName(env.TestSubAgentParent, parentName);

      expect(await agent.has("CounterSubAgent", childName)).toBe(false);

      await agent.subAgentPing(childName); // spawns it

      expect(await agent.has("CounterSubAgent", childName)).toBe(true);
    });

    it("hasSubAgent returns false after deleteSubAgent", async () => {
      const parentName = uniqueName();
      const childName = uniqueName();
      const agent = await getAgentByName(env.TestSubAgentParent, parentName);

      await agent.subAgentPing(childName);
      expect(await agent.has("CounterSubAgent", childName)).toBe(true);

      await agent.subAgentDelete(childName);
      expect(await agent.has("CounterSubAgent", childName)).toBe(false);
    });

    it("listSubAgents enumerates every spawned child", async () => {
      const parentName = uniqueName();
      const a = uniqueName();
      const b = uniqueName();
      const c = uniqueName();
      const agent = await getAgentByName(env.TestSubAgentParent, parentName);

      await agent.subAgentPing(a);
      await agent.subAgentPing(b);
      await agent.subAgentPing(c);

      const all = await agent.list();
      const names = all.map((r) => r.name).sort();
      expect(names).toEqual([a, b, c].sort());
      expect(all.every((r) => r.className === "CounterSubAgent")).toBe(true);
      expect(all.every((r) => typeof r.createdAt === "number")).toBe(true);
    });

    it("listSubAgents filters by class when provided", async () => {
      const parentName = uniqueName();
      const counter = uniqueName();
      const callback = uniqueName();
      const agent = await getAgentByName(env.TestSubAgentParent, parentName);

      await agent.subAgentPing(counter); // CounterSubAgent
      await agent.subAgentSameNameDifferentClass(callback); // spawns CounterSubAgent + CallbackSubAgent

      const counters = await agent.list("CounterSubAgent");
      const callbacks = await agent.list("CallbackSubAgent");

      expect(counters.some((r) => r.name === counter)).toBe(true);
      expect(counters.some((r) => r.name === callback)).toBe(true);
      expect(callbacks.some((r) => r.name === callback)).toBe(true);
      expect(callbacks.every((r) => r.className === "CallbackSubAgent")).toBe(
        true
      );
    });

    it("rejects a sub-agent name containing a null character", async () => {
      const parentName = uniqueName();
      const agent = await getAgentByName(env.TestSubAgentParent, parentName);

      const err = await agent.subAgentWithNullChar();
      expect(err).toMatch(/null character/i);
    });

    it("rejects a sub-agent class literally named 'Sub' at spawn time", async () => {
      const parentName = uniqueName();
      const agent = await getAgentByName(env.ReservedClassParent, parentName);
      const err = await agent.trySpawnReserved();
      expect(err).toMatch(/reserved/i);
      expect(err).toMatch(/Sub/);
    });

    it("rejects a sub-agent class named 'SUB' (all-uppercase kebab-cases to 'sub')", async () => {
      const parentName = uniqueName();
      const agent = await getAgentByName(env.ReservedClassParent, parentName);
      const err = await agent.trySpawnReservedUpper();
      // camelCaseToKebabCase("SUB") === "sub" via the all-uppercase
      // branch — the same URL-collision the `Sub` check guards.
      expect(err).toMatch(/reserved/i);
      expect(err).toMatch(/SUB/);
    });

    it("rejects a sub-agent class named 'Sub_' (trailing underscore kebab-cases to 'sub')", async () => {
      const parentName = uniqueName();
      const agent = await getAgentByName(env.ReservedClassParent, parentName);
      const err = await agent.trySpawnReservedTrailing();
      expect(err).toMatch(/reserved/i);
      // The class name appears verbatim in the error; the URL form is
      // the reserved "sub".
      expect(err).toMatch(/Sub_/);
    });

    it("hasSubAgent / listSubAgents accept both class ref and string name", async () => {
      const parentName = uniqueName();
      const childName = uniqueName();
      const agent = await getAgentByName(env.TestSubAgentParent, parentName);

      const result = await agent.introspectByBothForms(childName);
      expect(result.hasByCls).toBe(true);
      expect(result.hasByStr).toBe(true);
      expect(result.listByCls).toBeGreaterThan(0);
      expect(result.listByStr).toBeGreaterThan(0);
      expect(result.listByCls).toBe(result.listByStr);
    });
  });

  describe("deleteSubAgent idempotence", () => {
    it("deleting a never-spawned sub-agent succeeds silently", async () => {
      const parentName = uniqueName();
      const agent = await getAgentByName(env.TestSubAgentParent, parentName);

      const result = await agent.deleteUnknownSubAgent(uniqueName());
      expect(result.error).toBe("");
      expect(result.has).toBe(false);
    });

    it("deleting the same sub-agent twice succeeds silently", async () => {
      const parentName = uniqueName();
      const childName = uniqueName();
      const agent = await getAgentByName(env.TestSubAgentParent, parentName);

      const result = await agent.doubleDeleteSubAgent(childName);
      expect(result.error).toBe("");
    });
  });
});
