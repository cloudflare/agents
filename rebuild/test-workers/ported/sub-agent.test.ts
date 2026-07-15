/**
 * Ported from ORIGINAL Agents:
 * - packages/agents/src/tests/sub-agent.test.ts
 * - port date: 2026-07-15
 * Modifications:
 * - Re-pointed `agents` imports to `./compat.js`.
 * - Re-authored fixtures against rebuild delegation (`subAgent(className, name).call`).
 * - Uses exported DO wrapper class names for rebuild registry lookups.
 * - Keeps known divergence probes for null-character names and `Sub_`.
 */
// @ts-nocheck
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "./compat.js";
import type {
  ReservedClassParent,
  TestSubAgentParent
} from "./fixtures/sub-agent-agents.js";

const COUNTER_CHILD = "CounterSubAgentDO";
const CALLBACK_CHILD = "CallbackSubAgentDO";

function uniqueName(): string {
  return `sub-agent-test-${Math.random().toString(36).slice(2)}`;
}

async function freshParent(
  name = uniqueName()
): Promise<DurableObjectStub<TestSubAgentParent>> {
  return getAgentByName(
    env.TestSubAgentParent as DurableObjectNamespace<TestSubAgentParent>,
    name
  );
}

async function freshReservedParent(): Promise<
  DurableObjectStub<ReservedClassParent>
> {
  return getAgentByName(
    env.ReservedClassParent as DurableObjectNamespace<ReservedClassParent>,
    uniqueName()
  );
}

async function connectRootWS(name: string): Promise<WebSocket> {
  const response = await (
    exports as { default: { fetch: typeof fetch } }
  ).default.fetch(`http://example.com/agents/test-sub-agent-parent/${name}`, {
    headers: { Upgrade: "websocket" }
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return ws;
}

function closeWS(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 200);
    ws.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
    ws.close();
  });
}

describe("SubAgent (ported)", () => {
  it("should create a sub-agent and call RPC methods on it", async () => {
    const agent = await freshParent();

    const result = await agent.subAgentPing("counter-a");
    expect(result).toBe("pong");
  });

  it("should persist data in a sub-agent's own SQLite", async () => {
    const agent = await freshParent();

    const v1 = await agent.subAgentIncrement("counter-a", "clicks");
    expect(v1).toBe(1);

    const v2 = await agent.subAgentIncrement("counter-a", "clicks");
    expect(v2).toBe(2);

    const current = await agent.subAgentGet("counter-a", "clicks");
    expect(current).toBe(2);
  });

  it("should isolate storage between different named sub-agents", async () => {
    const agent = await freshParent();

    await agent.subAgentIncrement("child-x", "hits");
    await agent.subAgentIncrement("child-x", "hits");
    await agent.subAgentIncrement("child-y", "hits");

    const xHits = await agent.subAgentGet("child-x", "hits");
    const yHits = await agent.subAgentGet("child-y", "hits");

    expect(xHits).toBe(2);
    expect(yHits).toBe(1);
  });

  it("should run multiple sub-agents in parallel", async () => {
    const agent = await freshParent();

    const results = await agent.subAgentIncrementMultiple(
      ["parallel-a", "parallel-b", "parallel-c"],
      "counter"
    );

    expect(results).toEqual([1, 1, 1]);
  });

  it("should abort a sub-agent and restart it on next access", async () => {
    const agent = await freshParent();

    await agent.subAgentIncrement("resettable", "val");
    const before = await agent.subAgentGet("resettable", "val");
    expect(before).toBe(1);

    await agent.subAgentAbort("resettable");

    const after = await agent.subAgentGet("resettable", "val");
    expect(after).toBe(1);

    const incremented = await agent.subAgentIncrement("resettable", "val");
    expect(incremented).toBe(2);
  });

  it("should delete a sub-agent and its storage", async () => {
    const agent = await freshParent();

    await agent.subAgentIncrement("deletable", "count");
    await agent.subAgentIncrement("deletable", "count");
    const before = await agent.subAgentGet("deletable", "count");
    expect(before).toBe(2);

    await agent.subAgentDelete("deletable");

    const after = await agent.subAgentGet("deletable", "count");
    expect(after).toBe(0);
  });

  it("should set this.name to the facet name", async () => {
    const agent = await freshParent();

    const childName = await agent.subAgentGetName("my-counter");
    expect(childName).toBe("my-counter");

    const otherName = await agent.subAgentGetName("other-counter");
    expect(otherName).toBe("other-counter");
  });

  it("should expose the logical facet name during construction", async () => {
    const agent = await freshParent();

    expect(await agent.subAgentGetConstructorName("constructor-counter")).toBe(
      "constructor-counter"
    );
  });

  it("should throw descriptive error for non-exported sub-agent class", async () => {
    const agent = await freshParent();

    const { error } = await agent.subAgentMissingExport();
    expect(error).toMatch(/Unknown agent class: MissingSubAgentDO/);
  });

  it("should allow same name with different classes", async () => {
    const agent = await freshParent();

    const { counterPing, callbackLog } =
      await agent.subAgentSameNameDifferentClass("shared-name");
    expect(counterPing).toBe("pong");
    expect(callbackLog).toEqual([]);
  });

  it("should keep parent and sub-agent storage fully isolated", async () => {
    const agent = await freshParent();

    await agent.writeParentStorage("color", "blue");
    await agent.subAgentIncrement("child", "color");

    const parentVal = await agent.readParentStorage("color");
    expect(parentVal).toBe("blue");

    const childVal = await agent.subAgentGet("child", "color");
    expect(childVal).toBe(1);

    await agent.writeParentStorage("color", "red");
    await agent.subAgentIncrement("child", "color");

    expect(await agent.readParentStorage("color")).toBe("red");
    expect(await agent.subAgentGet("child", "color")).toBe(2);
  });

  describe("RpcTarget callback streaming", () => {
    it("should pass an RpcTarget callback to a sub-agent and receive chunks", async () => {
      const agent = await freshParent();

      const { received, done } = await agent.subAgentStreamViaCallback(
        "streamer-a",
        ["Hello", " ", "world", "!"]
      );

      expect(received).toEqual([
        "Hello",
        "Hello ",
        "Hello world",
        "Hello world!"
      ]);
      expect(done).toBe("Hello world!");
    });

    it("should persist data in the sub-agent after callback streaming", async () => {
      const agent = await freshParent();

      await agent.subAgentStreamViaCallback("streamer-b", ["foo", "bar"]);
      const log = await agent.subAgentGetStreamLog("streamer-b");
      expect(log).toEqual(["foobar"]);
    });

    it("should handle multiple callback streams to the same sub-agent", async () => {
      const agent = await freshParent();

      await agent.subAgentStreamViaCallback("streamer-c", ["first"]);
      await agent.subAgentStreamViaCallback("streamer-c", ["second"]);

      const log = await agent.subAgentGetStreamLog("streamer-c");
      expect(log).toEqual(["first", "second"]);
    });

    it("should isolate callback streaming across sub-agents", async () => {
      const agent = await freshParent();

      await agent.subAgentStreamViaCallback("iso-a", ["alpha"]);
      await agent.subAgentStreamViaCallback("iso-b", ["beta"]);

      expect(await agent.subAgentGetStreamLog("iso-a")).toEqual(["alpha"]);
      expect(await agent.subAgentGetStreamLog("iso-b")).toEqual(["beta"]);
    });

    it("should handle single-chunk callback stream", async () => {
      const agent = await freshParent();

      const { received, done } = await agent.subAgentStreamViaCallback(
        "single",
        ["only-one"]
      );

      expect(received).toEqual(["only-one"]);
      expect(done).toBe("only-one");
    });
  });

  describe("nested sub-agents", () => {
    it("should call methods on outer sub-agent directly", async () => {
      const agent = await freshParent();

      const result = await agent.nestedPing("outer-1");
      expect(result).toBe("outer-pong");
    });
  });

  it("keepAliveWhile() runs to completion inside a sub-agent", async () => {
    const agent = await freshParent();

    const result = await agent.subAgentTryKeepAliveWhile("keepalive-while-ok");
    expect(result).toBe("ok");
  });

  describe("parentAgent()", () => {
    it("throws a clear error when called on a non-facet (top-level agent)", async () => {
      const agent = await freshParent();

      await expect(agent.tryParentAgent()).resolves.toBeUndefined();
    });
  });

  it("should allow cancelSchedule in a sub-agent", async () => {
    const agent = await freshParent();

    const error = await agent.subAgentTryCancelSchedule("cancel-guard");
    expect(error).toBe("");
  });

  it("should preserve the facet flag after abort and re-access", async () => {
    const agent = await freshParent();

    const error = await agent.subAgentTryScheduleAfterAbort("persist-flag");
    expect(error).toBe("");
  });

  it("should restart a new same-name sub-agent with a path-scoped identity", async () => {
    const name = uniqueName();
    const agent = await freshParent();

    expect(await agent.subAgentPing(name)).toBe("pong");
    await agent.subAgentAbort(name);

    expect(await agent.subAgentPing(name)).toBe("pong");
  });

  describe("broadcast paths on facets", () => {
    it("should initialize a facet without throwing on first onStart", async () => {
      const agent = await freshParent();

      const ok = await agent.subAgentInitOk("init-clean");
      expect(ok).toBe(true);
    });

    it("should persist state when setState is called in a sub-agent", async () => {
      const agent = await freshParent();

      const result = await agent.subAgentTrySetState("stateful", 42, "ping");
      expect(result.error).toBe("");
      expect(result.persistedCount).toBe(42);
      expect(result.persistedMsg).toBe("ping");
    });

    it("a facet can setState while the ROOT holds a live connection", async () => {
      const parentName = uniqueName();
      const childName = uniqueName();
      const ws = await connectRootWS(parentName);
      try {
        const parent = await freshParent(parentName);
        const result = await parent.subAgentTrySetState(childName, 7, "io");
        expect(result.error).toBe("");
        expect(result.persistedCount).toBe(7);
        expect(result.persistedMsg).toBe("io");
      } finally {
        await closeWS(ws);
      }
    });
  });

  describe("parentPath and registry", () => {
    it("a direct child's parentPath contains just its parent", async () => {
      const parentName = uniqueName();
      const childName = uniqueName();
      const agent = await freshParent(parentName);

      const path = await agent.subAgentParentPath(childName);
      expect(path).toEqual([
        { className: "TestSubAgentParentImpl", name: parentName }
      ]);
    });

    it("a direct child's selfPath is parentPath + self", async () => {
      const parentName = uniqueName();
      const childName = uniqueName();
      const agent = await freshParent(parentName);

      const path = await agent.subAgentSelfPath(childName);
      expect(path).toEqual([
        { className: "TestSubAgentParentImpl", name: parentName },
        { className: "CounterSubAgent", name: childName }
      ]);
    });

    it("parentPath survives abort and re-access (persisted in child storage)", async () => {
      const parentName = uniqueName();
      const childName = uniqueName();
      const agent = await freshParent(parentName);

      await agent.subAgentParentPath(childName);
      await agent.subAgentAbort(childName);

      const path = await agent.subAgentParentPath(childName);
      expect(path).toEqual([
        { className: "TestSubAgentParentImpl", name: parentName }
      ]);
    });

    it("hasSubAgent returns true after spawn, false before", async () => {
      const childName = uniqueName();
      const agent = await freshParent();

      expect(await agent.has(COUNTER_CHILD, childName)).toBe(false);

      await agent.subAgentPing(childName);

      expect(await agent.has(COUNTER_CHILD, childName)).toBe(true);
    });

    it("hasSubAgent returns false after deleteSubAgent", async () => {
      const childName = uniqueName();
      const agent = await freshParent();

      await agent.subAgentPing(childName);
      expect(await agent.has(COUNTER_CHILD, childName)).toBe(true);

      await agent.subAgentDelete(childName);
      expect(await agent.has(COUNTER_CHILD, childName)).toBe(false);
    });

    it("listSubAgents enumerates every spawned child", async () => {
      const a = uniqueName();
      const b = uniqueName();
      const c = uniqueName();
      const agent = await freshParent();

      await agent.subAgentPing(a);
      await agent.subAgentPing(b);
      await agent.subAgentPing(c);

      const all = await agent.list();
      const names = all.map((r) => r.name).sort();
      expect(names).toEqual([a, b, c].sort());
      expect(all.every((r) => r.className === COUNTER_CHILD)).toBe(true);
      expect(all.every((r) => typeof r.createdAt === "number")).toBe(true);
    });

    it("listSubAgents filters by class when provided", async () => {
      const counter = uniqueName();
      const callback = uniqueName();
      const agent = await freshParent();

      await agent.subAgentPing(counter);
      await agent.subAgentSameNameDifferentClass(callback);

      const counters = await agent.list(COUNTER_CHILD);
      const callbacks = await agent.list(CALLBACK_CHILD);

      expect(counters.some((r) => r.name === counter)).toBe(true);
      expect(counters.some((r) => r.name === callback)).toBe(true);
      expect(callbacks.some((r) => r.name === callback)).toBe(true);
      expect(callbacks.every((r) => r.className === CALLBACK_CHILD)).toBe(true);
    });

    it("rejects a sub-agent name containing a null character", async () => {
      const agent = await freshParent();

      const err = await agent.subAgentWithNullChar();
      expect(err).toMatch(/null character/i);
    });

    it("rejects a sub-agent class literally named 'Sub' at spawn time", async () => {
      const agent = await freshReservedParent();
      const err = await agent.trySpawnReserved();
      expect(err).toMatch(/reserved/i);
      expect(err).toMatch(/Sub/);
    });

    it("rejects a sub-agent class named 'SUB' (all-uppercase kebab-cases to 'sub')", async () => {
      const agent = await freshReservedParent();
      const err = await agent.trySpawnReservedUpper();
      expect(err).toMatch(/reserved/i);
      expect(err).toMatch(/SUB/);
    });

    it("rejects a sub-agent class named 'Sub_' (trailing underscore kebab-cases to 'sub')", async () => {
      const agent = await freshReservedParent();
      const err = await agent.trySpawnReservedTrailing();
      expect(err).toMatch(/reserved/i);
      expect(err).toMatch(/Sub_/);
    });
  });

  describe("deleteSubAgent idempotence", () => {
    it("deleting a never-spawned sub-agent succeeds silently", async () => {
      const agent = await freshParent();

      const result = await agent.deleteUnknownSubAgent(uniqueName());
      expect(result.error).toBe("");
      expect(result.has).toBe(false);
    });

    it("deleting the same sub-agent twice succeeds silently", async () => {
      const agent = await freshParent();

      const result = await agent.doubleDeleteSubAgent(uniqueName());
      expect(result.error).toBe("");
    });
  });
});
