import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "../index";

function uniqueName() {
  return `sub-agent-test-${Math.random().toString(36).slice(2)}`;
}

describe.skip("SubAgent", () => {
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

  it("should throw a clear error when keepAlive in a sub-agent", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    const error = await agent.subAgentTryKeepAlive("keepalive-guard");
    expect(error).toMatch(/not supported in sub-agents/);
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
});
