import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "../index";
import { MessageType } from "../types";

function uniqueName() {
  return `sub-agent-test-${Math.random().toString(36).slice(2)}`;
}

async function connectWS(path: string): Promise<WebSocket> {
  const res = await exports.default.fetch(`http://example.com${path}`, {
    headers: { Upgrade: "websocket" }
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return ws;
}

function waitForJsonMessage<T>(
  ws: WebSocket,
  predicate: (data: T) => boolean,
  timeoutMs = 5000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error(`waitForJsonMessage timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const handler = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as T;
        if (predicate(data)) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve(data);
        }
      } catch {
        // Ignore non-JSON protocol frames.
      }
    };
    ws.addEventListener("message", handler);
  });
}

async function expectRootKeepAliveRefCount(
  agent: { getRootKeepAliveRefCount(): Promise<number> },
  expected: number
) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const count = await agent.getRootKeepAliveRefCount();
    if (count === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(await agent.getRootKeepAliveRefCount()).toBe(expected);
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

  it("should schedule delayed callbacks from a sub-agent and execute inside the child", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    const scheduleId = await agent.subAgentScheduleDelayed(
      "sched-child",
      60,
      "hello"
    );
    const rows = await agent.rootScheduleRows();
    const row = rows.find((r) => r.id === scheduleId);
    expect(row).toMatchObject({
      callback: "scheduledCallback",
      type: "delayed"
    });
    expect(row?.ownerPath).toContain("CounterSubAgent");

    await agent.backdateSchedule(scheduleId);
    await runDurableObjectAlarm(agent);

    const log = await agent.subAgentScheduleLog("sched-child");
    expect(log).toEqual([
      {
        value: "hello",
        agentName: "sched-child",
        currentAgentName: "sched-child",
        parentClass: "TestSubAgentParent",
        scheduleId,
        callback: "scheduledCallback"
      }
    ]);
  });

  it("should keep sub-agent interval schedules recurring and idempotent", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    const first = await agent.subAgentScheduleInterval(
      "interval-child",
      60,
      "tick"
    );
    const second = await agent.subAgentScheduleInterval(
      "interval-child",
      60,
      "tick"
    );
    expect(second).toBe(first);

    await agent.backdateSchedule(first);
    await runDurableObjectAlarm(agent);

    expect(await agent.subAgentScheduleLog("interval-child")).toHaveLength(1);
    const rows = await agent.rootScheduleRows();
    expect(rows.find((r) => r.id === first)?.type).toBe("interval");
  });

  it("should cancel a sub-agent schedule from the child API", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    const scheduleId = await agent.subAgentScheduleDelayed(
      "cancel-child",
      60,
      "cancelled"
    );
    expect(await agent.subAgentCancelSchedule("cancel-child", scheduleId)).toBe(
      true
    );

    await agent.backdateSchedule(scheduleId);
    await runDurableObjectAlarm(agent);

    expect(await agent.subAgentScheduleLog("cancel-child")).toEqual([]);
    expect(
      (await agent.rootScheduleRows()).some((r) => r.id === scheduleId)
    ).toBe(false);
  });

  it("should read sub-agent schedules through the async APIs", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    const scheduleId = await agent.subAgentScheduleDelayed(
      "query-child",
      60,
      "query"
    );

    const schedule = await agent.subAgentGetSchedule("query-child", scheduleId);
    expect(schedule?.id).toBe(scheduleId);
    expect(schedule?.callback).toBe("scheduledCallback");

    const schedules = await agent.subAgentGetSchedulesByType(
      "query-child",
      "delayed"
    );
    expect(schedules).toContain(scheduleId);
  });

  it("does not expose root storage columns from sub-agent schedule APIs", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    await agent.subAgentScheduleDelayed("public-shape-child", 60, "shape");

    expect(
      await agent.subAgentGetScheduleKeysByType("public-shape-child", "delayed")
    ).toEqual([
      ["callback", "delayInSeconds", "id", "payload", "retry", "time", "type"]
    ]);
  });

  it("should throw from sync schedule query APIs inside a sub-agent", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    const scheduleId = await agent.subAgentScheduleDelayed(
      "sync-query-child",
      60,
      "query"
    );

    await expect(
      agent.subAgentTrySyncGetSchedule("sync-query-child", scheduleId)
    ).resolves.toMatch(/getSchedule\(\) is synchronous/);
    await expect(
      agent.subAgentTrySyncGetSchedules("sync-query-child")
    ).resolves.toMatch(/getSchedules\(\) is synchronous/);
  });

  it("should prune a stale sub-agent schedule when the registry entry is gone", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    const scheduleId = await agent.subAgentScheduleDelayed(
      "missing-registry-child",
      60,
      "kept"
    );
    await agent.forgetCounterSubAgentRegistry("missing-registry-child");
    await agent.backdateSchedule(scheduleId);

    await runDurableObjectAlarm(agent);

    const rows = await agent.rootScheduleRows();
    expect(rows.some((r) => r.id === scheduleId)).toBe(false);
    expect(await agent.subAgentScheduleLog("missing-registry-child")).toEqual(
      []
    );
  });

  it("should dispatch nested sub-agent schedules through each parent hop", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    const scheduleId = await agent.nestedScheduleSet(
      "outer-scheduler",
      "inner-scheduler",
      60,
      "scheduled-key",
      "scheduled-value"
    );

    await agent.backdateSchedule(scheduleId);
    await runDurableObjectAlarm(agent);

    expect(
      await agent.nestedGetValue(
        "outer-scheduler",
        "inner-scheduler",
        "scheduled-key"
      )
    ).toBe("scheduled-value");
  });

  it("should remove pending schedules when deleting a sub-agent", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    const scheduleId = await agent.subAgentScheduleDelayed(
      "delete-scheduled-child",
      60,
      "orphan"
    );
    await agent.subAgentDelete("delete-scheduled-child");

    expect(
      (await agent.rootScheduleRows()).some((r) => r.id === scheduleId)
    ).toBe(false);
  });

  it("should not treat slashes in sub-agent names as schedule path separators", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    const siblingId = await agent.subAgentScheduleDelayed(
      "slash-child/nested-looking",
      60,
      "kept"
    );
    await agent.subAgentScheduleDelayed("slash-child", 60, "deleted");

    await agent.subAgentDelete("slash-child");

    const rows = await agent.rootScheduleRows();
    expect(rows.some((r) => r.id === siblingId)).toBe(true);
  });

  it("should not treat SQL LIKE wildcard characters in names as schedule path wildcards", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    const siblingId = await agent.subAgentScheduleDelayed(
      "wildXchild/nested",
      60,
      "kept"
    );
    await agent.subAgentScheduleDelayed("wild%child", 60, "deleted");

    await agent.subAgentDelete("wild%child");

    const rows = await agent.rootScheduleRows();
    expect(rows.some((r) => r.id === siblingId)).toBe(true);
  });

  it("supports cron schedules from inside a sub-agent", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    // "Every minute" — written as a row, not yet executed.
    const scheduleId = await agent.subAgentScheduleCron(
      "cron-child",
      "* * * * *",
      "tick"
    );

    const rows = await agent.rootScheduleRows();
    const row = rows.find((r) => r.id === scheduleId);
    expect(row).toBeDefined();
    expect(row?.type).toBe("cron");
    expect(row?.ownerPath).toContain("CounterSubAgent");
    expect(row?.ownerPathKey).toContain("CounterSubAgent");

    // Backdate and run the alarm; the cron callback should dispatch
    // into the facet, then the row's `time` is rescheduled forward.
    await agent.backdateSchedule(scheduleId);
    await runDurableObjectAlarm(agent);

    const log = await agent.subAgentScheduleLog("cron-child");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      value: "tick",
      agentName: "cron-child",
      currentAgentName: "cron-child",
      callback: "scheduledCallback"
    });

    // The cron row stays alive (it just rescheduled itself forward).
    const after = await agent.rootScheduleRows();
    expect(after.some((r) => r.id === scheduleId)).toBe(true);
  });

  it("isolates cancelSchedule(id) by owner — siblings can't cancel each other", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    const idA = await agent.subAgentScheduleDelayed(
      "isolation-a",
      60,
      "from-a"
    );
    const idB = await agent.subAgentScheduleDelayed(
      "isolation-b",
      60,
      "from-b"
    );
    expect(idA).not.toBe(idB);

    // Sibling tries to cancel A's schedule by id — must miss.
    expect(await agent.subAgentCancelSiblingSchedule("isolation-b", idA)).toBe(
      false
    );

    // Top-level tries to cancel A's schedule by id — must also miss
    // (top-level only owns rows where owner_path is null).
    expect(await agent.parentCancelByIdNoFacet(idA)).toBe(false);

    // Owner can still cancel its own.
    expect(await agent.subAgentCancelSchedule("isolation-a", idA)).toBe(true);

    const rows = await agent.rootScheduleRows();
    expect(rows.some((r) => r.id === idA)).toBe(false);
    expect(rows.some((r) => r.id === idB)).toBe(true);
  });

  it("treats same callback+payload across sibling sub-agents as distinct schedules", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    // Idempotent insert with identical payload — but different
    // siblings, so the owner_path_key differs and the row dedup
    // must NOT match across siblings.
    const idA = await agent.subAgentScheduleInterval(
      "idemp-sib-a",
      60,
      "shared"
    );
    const idB = await agent.subAgentScheduleInterval(
      "idemp-sib-b",
      60,
      "shared"
    );

    expect(idA).not.toBe(idB);

    const rows = await agent.rootScheduleRows();
    const matched = rows.filter((r) => r.id === idA || r.id === idB);
    expect(matched).toHaveLength(2);
  });

  it("cleans up grandchild schedules when an ancestor sub-agent is deleted", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    // root → outer → inner; schedule lives on inner.
    const grandchildId = await agent.nestedScheduleSet(
      "deep-outer",
      "deep-inner",
      60,
      "key",
      "value"
    );

    let rows = await agent.rootScheduleRows();
    expect(rows.some((r) => r.id === grandchildId)).toBe(true);

    // Tearing down OUTER must transitively clear the inner's schedule.
    // We exercise the destroy-from-facet path here (outerSelfDestruct
    // calls `this.destroy()` from inside the outer facet) — the same
    // bulk-cancel logic also runs from a parent-side
    // `deleteSubAgent`.
    await agent.outerSelfDestruct("deep-outer");

    rows = await agent.rootScheduleRows();
    expect(rows.some((r) => r.id === grandchildId)).toBe(false);
  });

  it("self-cancel from inside a dispatched callback completes without deadlock", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    const scheduleId = await agent.subAgentScheduleSelfCancellingCallback(
      "self-cancel-child",
      60,
      "boom"
    );

    await agent.backdateSchedule(scheduleId);
    await runDurableObjectAlarm(agent);

    // The callback ran (log entry written) and the row is gone
    // (one-shot rows are deleted post-execute regardless).
    const log = await agent.subAgentScheduleLog("self-cancel-child");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      value: "boom",
      callback: "selfCancellingCallback"
    });

    const rows = await agent.rootScheduleRows();
    expect(rows.some((r) => r.id === scheduleId)).toBe(false);
  });

  it("destroy() inside a sub-agent clears its schedules and its parent registry entry", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    const scheduleId = await agent.subAgentScheduleDelayed(
      "self-destruct",
      60,
      "gone"
    );

    // Sanity: schedule + registry entry both exist.
    expect(
      (await agent.rootScheduleRows()).some((r) => r.id === scheduleId)
    ).toBe(true);
    expect(
      (await agent.subAgentRegistryRows()).some(
        (r) => r.class === "CounterSubAgent" && r.name === "self-destruct"
      )
    ).toBe(true);

    // Have the sub-agent destroy itself. The RPC frame may or may
    // not return cleanly — the helper swallows abort errors.
    await agent.subAgentSelfDestruct("self-destruct");

    // After destruction:
    // - Parent-owned schedule rows for this facet are gone.
    // - Parent's `cf_agents_sub_agents` registry entry is cleared.
    expect(
      (await agent.rootScheduleRows()).some((r) => r.id === scheduleId)
    ).toBe(false);
    expect(
      (await agent.subAgentRegistryRows()).some(
        (r) => r.class === "CounterSubAgent" && r.name === "self-destruct"
      )
    ).toBe(false);

    // Re-accessing the same name spawns a fresh facet with empty
    // storage. Schedule log from the previous instance must NOT
    // survive.
    const log = await agent.subAgentScheduleLog("self-destruct");
    expect(log).toEqual([]);
  });

  it("deleteSubAgent clears root-side facet fiber leases for that sub-tree", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    await agent.insertSubAgentInterruptedFiber(
      "delete-fiber-child",
      "delete-fiber-1",
      "delete-work"
    );
    expect((await agent.facetRunRows()).map((row) => row.runId)).toContain(
      "delete-fiber-1"
    );

    await agent.subAgentDelete("delete-fiber-child");

    expect(await agent.facetRunRows()).toEqual([]);
  });

  it("destroy() inside a sub-agent clears root-side facet fiber leases immediately", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    await agent.insertSubAgentInterruptedFiber(
      "self-destruct-fiber-child",
      "self-destruct-fiber-1",
      "self-destruct-work"
    );
    expect((await agent.facetRunRows()).map((row) => row.runId)).toContain(
      "self-destruct-fiber-1"
    );

    await agent.subAgentSelfDestruct("self-destruct-fiber-child");

    expect(await agent.facetRunRows()).toEqual([]);
  });

  it("destroy() inside an outer sub-agent transitively cleans up inner descendants", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    // root → outer → inner with a schedule on inner.
    const innerScheduleId = await agent.nestedScheduleSet(
      "outer-self-destruct",
      "inner-victim",
      60,
      "key",
      "value"
    );

    expect(
      (await agent.rootScheduleRows()).some((r) => r.id === innerScheduleId)
    ).toBe(true);

    await agent.outerSelfDestruct("outer-self-destruct");

    expect(
      (await agent.rootScheduleRows()).some((r) => r.id === innerScheduleId)
    ).toBe(false);

    // Outer's registry entry on the root is cleared.
    expect(
      (await agent.subAgentRegistryRows()).some(
        (r) => r.class === "OuterSubAgent" && r.name === "outer-self-destruct"
      )
    ).toBe(false);
  });

  it("emits schedule:create / schedule:cancel observability on the facet, not the alarm-owning root", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    await agent.installRecordersOn("emit-source-child");

    const scheduleId = await agent.subAgentScheduleDelayed(
      "emit-source-child",
      60,
      "ev"
    );

    // schedule:create must fire on the FACET, not the parent.
    const childCreate = (
      await agent.subAgentObservabilityLog("emit-source-child")
    ).filter((e) => e.type === "schedule:create");
    expect(childCreate).toHaveLength(1);
    expect(childCreate[0].agent).toBe("CounterSubAgent");
    expect(childCreate[0].agentName).toBe("emit-source-child");
    expect(childCreate[0].payload).toMatchObject({
      callback: "scheduledCallback",
      id: scheduleId
    });

    const parentCreate = (await agent.getObservabilityLog()).filter(
      (e) => e.type === "schedule:create"
    );
    expect(parentCreate).toHaveLength(0);

    // schedule:cancel must also fire on the FACET, not the parent.
    expect(
      await agent.subAgentCancelSchedule("emit-source-child", scheduleId)
    ).toBe(true);

    const childCancel = (
      await agent.subAgentObservabilityLog("emit-source-child")
    ).filter((e) => e.type === "schedule:cancel");
    expect(childCancel).toHaveLength(1);
    expect(childCancel[0].agent).toBe("CounterSubAgent");
    expect(childCancel[0].agentName).toBe("emit-source-child");
    expect(childCancel[0].payload).toMatchObject({
      callback: "scheduledCallback",
      id: scheduleId
    });

    const parentCancel = (await agent.getObservabilityLog()).filter(
      (e) => e.type === "schedule:cancel"
    );
    expect(parentCancel).toHaveLength(0);
  });

  it("prunes stale interval rows when facet dispatch cannot reach the owner", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    const intervalId = await agent.subAgentScheduleInterval(
      "running-reset-child",
      60,
      "tick"
    );

    // Wipe the registry entry so dispatch fails on the next alarm.
    await agent.forgetCounterSubAgentRegistry("running-reset-child");
    await agent.backdateSchedule(intervalId);

    await runDurableObjectAlarm(agent);

    const rows = await agent.rootScheduleRows();
    const row = rows.find((r) => r.id === intervalId);
    expect(row).toBeUndefined();
  });

  it("keepAlive() delegates heartbeat refs from a sub-agent to the root", async () => {
    // Regression: earlier versions banned keepAlive on facets, which
    // crashed every streaming turn in an AIChatAgent facet
    // (`_reply` uses `keepAliveWhile` to guard stream commit).
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    expect(await agent.getRootKeepAliveRefCount()).toBe(0);
    const error = await agent.subAgentTryKeepAlive("keepalive-ok");
    expect(error).toBe("");
    await expectRootKeepAliveRefCount(agent, 0);
  });

  it("keepAliveWhile() runs to completion inside a sub-agent", async () => {
    // Mirror AIChatAgent._reply's exact call shape.
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    const result = await agent.subAgentTryKeepAliveWhile("keepalive-while-ok");
    expect(result).toBe("ok");
  });

  it("keepAliveWhile() releases delegated refs when a sub-agent callback throws", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    const result = await agent.subAgentTryKeepAliveWhileError(
      "keepalive-while-error"
    );

    expect(result).toBe("keepalive failure");
    await expectRootKeepAliveRefCount(agent, 0);
  });

  it("tracks multiple delegated keepAlive refs across sibling sub-agents", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    await agent.subAgentAcquireHeldKeepAlive("keepalive-sibling-a");
    await agent.subAgentAcquireHeldKeepAlive("keepalive-sibling-a");
    await agent.subAgentAcquireHeldKeepAlive("keepalive-sibling-b");

    expect(await agent.getRootKeepAliveRefCount()).toBe(3);

    await agent.subAgentReleaseHeldKeepAlives("keepalive-sibling-a");
    await expectRootKeepAliveRefCount(agent, 1);

    await agent.subAgentReleaseHeldKeepAlives("keepalive-sibling-b");
    await expectRootKeepAliveRefCount(agent, 0);
  });

  it("holds root keepAlive and root facet-run leases while a sub-agent fiber is active", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    const fiberId = await agent.subAgentHoldFiber("fiber-child", "held");

    expect(await agent.getRootKeepAliveRefCount()).toBe(1);
    expect(await agent.subAgentRunningFiberCount("fiber-child")).toBe(1);
    expect((await agent.facetRunRows()).map((row) => row.runId)).toContain(
      fiberId
    );

    // The root alarm may check the active fiber, but the child sees
    // it in `_runFiberActiveFibers`, so recovery must not run.
    await runDurableObjectAlarm(agent);
    expect(await agent.subAgentRecoveredFibers("fiber-child")).toEqual([]);
    expect((await agent.facetRunRows()).map((row) => row.runId)).toContain(
      fiberId
    );

    await agent.subAgentReleaseHeldFiber("fiber-child");

    expect(await agent.subAgentRunningFiberCount("fiber-child")).toBe(0);
    expect(await agent.facetRunRows()).toEqual([]);
    await expectRootKeepAliveRefCount(agent, 0);
  });

  it("recovers an interrupted sub-agent fiber from the root alarm", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    await agent.insertSubAgentInterruptedFiber(
      "recover-child",
      "fiber-recover-1",
      "recover-work",
      { value: "checkpoint" }
    );
    expect((await agent.facetRunRows()).map((row) => row.runId)).toContain(
      "fiber-recover-1"
    );

    await runDurableObjectAlarm(agent);

    expect(await agent.subAgentRunningFiberCount("recover-child")).toBe(0);
    expect(await agent.facetRunRows()).toEqual([]);
    expect(await agent.subAgentRecoveredFibers("recover-child")).toEqual([
      expect.objectContaining({
        id: "fiber-recover-1",
        name: "recover-work",
        snapshot: { value: "checkpoint" }
      })
    ]);
  });

  it("lets internal sub-agent fiber recovery schedule continuation work in the child", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    await agent.insertSubAgentInterruptedFiber(
      "chat-recovery-child",
      "chat-fiber-1",
      "__test_internal_chat"
    );

    await runDurableObjectAlarm(agent);

    expect(await agent.facetRunRows()).toEqual([]);
    expect(await agent.subAgentRecoveredFibers("chat-recovery-child")).toEqual(
      []
    );

    await runDurableObjectAlarm(agent);

    expect(await agent.subAgentScheduleLog("chat-recovery-child")).toEqual([
      expect.objectContaining({
        value: "recovered:chat-fiber-1",
        callback: "scheduledCallback"
      })
    ]);
  });

  it("recovers an interrupted nested sub-agent fiber through each parent hop", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    await agent.insertNestedInterruptedFiber(
      "fiber-outer",
      "fiber-inner",
      "nested-fiber-1",
      "nested-work",
      { value: "nested-checkpoint" }
    );

    expect((await agent.facetRunRows()).map((row) => row.runId)).toContain(
      "nested-fiber-1"
    );

    await runDurableObjectAlarm(agent);

    expect(await agent.facetRunRows()).toEqual([]);
    expect(
      await agent.nestedRecoveredFibers("fiber-outer", "fiber-inner")
    ).toEqual([
      expect.objectContaining({
        id: "nested-fiber-1",
        name: "nested-work",
        snapshot: { value: "nested-checkpoint" }
      })
    ]);
  });

  it("prunes stale root facet-run leases when the facet has no run rows", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    await agent.registerSubAgentFacetRunLeaseOnly(
      "stale-fiber-child",
      "stale-fiber-1"
    );
    expect((await agent.facetRunRows()).map((row) => row.runId)).toContain(
      "stale-fiber-1"
    );

    // There is a root-side lease but no child cf_agents_runs row.
    // Root housekeeping should dispatch into the child, observe zero
    // remaining rows, and prune the stale root index entry.
    await runDurableObjectAlarm(agent);

    expect(await agent.facetRunRows()).toEqual([]);
  });

  it("prunes root facet-run leases when the facet registry entry is gone", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    await agent.registerSubAgentFacetRunLeaseOnly(
      "missing-fiber-child",
      "missing-fiber-1"
    );
    await agent.forgetCounterSubAgentRegistry("missing-fiber-child");

    await runDurableObjectAlarm(agent);

    expect(await agent.facetRunRows()).toEqual([]);
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

  it("should allow cancelSchedule in a sub-agent", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    const error = await agent.subAgentTryCancelSchedule("cancel-guard");
    expect(error).toBe("");
  });

  it("should preserve the facet flag after abort and re-access", async () => {
    const name = uniqueName();
    const agent = await getAgentByName(env.TestSubAgentParent, name);

    // This test aborts the sub-agent (killing the instance) then
    // re-accesses it. The _isFacet flag must survive via storage.
    const error = await agent.subAgentTryScheduleAfterAbort("persist-flag");
    expect(error).toBe("");
  });

  it("should spawn a sub-agent from a WebSocket onMessage turn", async () => {
    const name = uniqueName();
    const ws = await connectWS(`/agents/test-sub-agent-parent/${name}`);
    try {
      const resultPromise = waitForJsonMessage<{
        type: string;
        ok: boolean;
        result?: string;
        error?: string;
      }>(ws, (data) => data.type === "sub-agent-result");

      ws.send("spawn-sub-agent");

      const message = await resultPromise;
      expect(message).toEqual({
        type: "sub-agent-result",
        ok: true,
        result: "pong"
      });
    } finally {
      ws.close();
    }
  });

  // ── Regression: cross-DO I/O on bootstrap broadcast paths ───────────
  // Sub-agents share their parent's process but have their own isolate.
  // On production, iterating the connection registry or sending through
  // a parent-owned WebSocket during facet bootstrap throws "Cannot
  // perform I/O on behalf of a different Durable Object". Startup
  // protocol broadcasts are suppressed, but normal facet broadcasts
  // after bootstrap must still reach the facet's own WebSocket clients.

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

    it("should not throw when a sub-agent calls this.broadcast(...)", async () => {
      const name = uniqueName();
      const agent = await getAgentByName(env.TestSubAgentParent, name);

      const error = await agent.subAgentTryBroadcast(
        "broadcaster",
        "hello from facet"
      );
      expect(error).toBe("");
    });

    it("should persist state when setState is called in a sub-agent", async () => {
      const name = uniqueName();
      const agent = await getAgentByName(env.TestSubAgentParent, name);

      const result = await agent.subAgentTrySetState("stateful", 42, "ping");
      expect(result.error).toBe("");
      expect(result.persistedCount).toBe(42);
      expect(result.persistedMsg).toBe("ping");
    });

    it("should broadcast state updates to WebSocket clients connected directly to a sub-agent", async () => {
      const parentName = uniqueName();
      const childName = uniqueName();
      const ws = await connectWS(
        `/agents/test-sub-agent-parent/${parentName}/sub/broadcast-sub-agent/${childName}`
      );
      try {
        await waitForJsonMessage<{
          type: MessageType;
          state?: { count: number; lastMsg: string };
        }>(
          ws,
          (data) =>
            data.type === MessageType.CF_AGENT_STATE && data.state?.count === 0
        );

        const stateUpdatePromise = waitForJsonMessage<{
          type: MessageType;
          state?: { count: number; lastMsg: string };
        }>(
          ws,
          (data) =>
            data.type === MessageType.CF_AGENT_STATE && data.state?.count === 42
        );

        const parent = await getAgentByName(env.TestSubAgentParent, parentName);
        const result = await parent.subAgentTrySetState(childName, 42, "ping");
        expect(result.error).toBe("");

        const update = await stateUpdatePromise;
        expect(update.state).toEqual({ count: 42, lastMsg: "ping" });
      } finally {
        ws.close();
      }
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
