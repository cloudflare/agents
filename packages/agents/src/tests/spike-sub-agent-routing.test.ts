/**
 * Spike tests for sub-agent external addressability.
 *
 * Proves that a facet (created via `subAgent()` and obtained via
 * `ctx.facets.get()`) is reachable via a double-hop `fetch()` chain
 * — Worker → parent DO → facet Fetcher — for both WebSocket upgrades
 * and regular HTTP.
 *
 * Critical invariant we verify: after the initial WS upgrade, the
 * **parent's `fetch()` handler is not re-entered** for subsequent
 * frames. That's what makes this primitive usable for per-chat DOs
 * in a multi-session app: the parent gets to gatekeep at connection
 * time, then steps out of the hot path.
 */

import { exports, env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "../index";

function uniqueName() {
  return `spike-${Math.random().toString(36).slice(2)}`;
}

async function connectViaSpike(
  parent: string,
  childClass: string,
  child: string
) {
  const url = `http://example.com/spike-sub/${parent}/sub/${childClass}/${child}`;
  const res = await exports.default.fetch(url, {
    headers: { Upgrade: "websocket" }
  });
  return { res };
}

async function openWS(
  parent: string,
  childClass: string,
  child: string
): Promise<WebSocket> {
  const { res } = await connectViaSpike(parent, childClass, child);
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return ws;
}

/**
 * Collect messages matching `predicate`. Skips agent-protocol frames
 * (`cf_agent_identity`, etc.) so the caller sees only the
 * application-level echoes it cares about.
 */
function collectMessages(
  ws: WebSocket,
  count: number,
  predicate: (data: string) => boolean = isEchoPong,
  timeout = 2000
): Promise<string[]> {
  return new Promise((resolve) => {
    const messages: string[] = [];
    const timer = setTimeout(() => {
      resolve(messages);
    }, timeout);
    const handler = (e: MessageEvent) => {
      const data = e.data as string;
      if (!predicate(data)) return;
      messages.push(data);
      if (messages.length >= count) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(messages);
      }
    };
    ws.addEventListener("message", handler);
  });
}

function isEchoPong(data: string): boolean {
  return typeof data === "string" && data.startsWith("pong:");
}

describe("Spike: sub-agent routing via facet Fetcher", () => {
  it("establishes a WebSocket through the parent → facet chain", async () => {
    const parent = uniqueName();
    const child = uniqueName();

    const ws = await openWS(parent, "SpikeSubChild", child);

    ws.send("hello");
    const [reply] = await collectMessages(ws, 1);
    expect(reply).toBe(`pong:${child}:hello`);

    ws.close();
  });

  it("routes subsequent frames direct to the facet, not back through the parent", async () => {
    const parent = uniqueName();
    const child = uniqueName();

    // Reset counters
    const parentStub = await getAgentByName(env.SpikeSubParent, parent);
    await parentStub.resetCounts();

    const ws = await openWS(parent, "SpikeSubChild", child);

    // Send a burst of messages. If each one round-tripped through the
    // parent DO's `fetch()` handler, `fetchCount` would jump by 10.
    const N = 10;
    for (let i = 0; i < N; i++) {
      ws.send(`msg-${i}`);
    }

    const replies = await collectMessages(ws, N);
    expect(replies).toHaveLength(N);
    // Order can vary — child's async onMessage may interleave. What
    // we care about is that every send got a matching pong.
    const expected = new Set(
      Array.from({ length: N }, (_, i) => `pong:${child}:msg-${i}`)
    );
    expect(new Set(replies)).toEqual(expected);

    // Parent was only entered once: for the initial WS upgrade.
    const fetchTotal = await parentStub.getCount("fetch_total");
    const fetchForwarded = await parentStub.getCount("fetch_forwarded");
    expect(fetchTotal).toBe(1);
    expect(fetchForwarded).toBe(1);

    // There's no standalone binding for SpikeSubChild (it's a facet),
    // so we can't query its SQLite counter directly from the test.
    // The echo protocol above is our proof: the pongs came from the
    // child (identified via `this.name`) with the right content.

    ws.close();
  });

  it("forwards HTTP requests through the same chain", async () => {
    const parent = uniqueName();
    const child = uniqueName();

    const parentStub = await getAgentByName(env.SpikeSubParent, parent);
    await parentStub.resetCounts();

    const res = await exports.default.fetch(
      `http://example.com/spike-sub/${parent}/sub/SpikeSubChild/${child}/anything`,
      { method: "POST", body: "payload" }
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      child: string;
      path: string;
    };
    expect(body.kind).toBe("child-http");
    expect(body.child).toBe(child);
    // The path the child sees has been stripped of the /sub/... prefix.
    expect(body.path).toBe("/anything");

    const fetchForwarded = await parentStub.getCount("fetch_forwarded");
    expect(fetchForwarded).toBe(1);
  });

  it("isolates per-child state across different child names", async () => {
    const parent = uniqueName();
    const childA = uniqueName();
    const childB = uniqueName();

    const wsA = await openWS(parent, "SpikeSubChild", childA);
    const wsB = await openWS(parent, "SpikeSubChild", childB);

    wsA.send("from-a");
    wsB.send("from-b");

    const [replyA] = await collectMessages(wsA, 1);
    const [replyB] = await collectMessages(wsB, 1);

    expect(replyA).toBe(`pong:${childA}:from-a`);
    expect(replyB).toBe(`pong:${childB}:from-b`);

    wsA.close();
    wsB.close();
  });

  it("rejects an unknown child class with 404", async () => {
    const parent = uniqueName();
    const res = await exports.default.fetch(
      `http://example.com/spike-sub/${parent}/sub/NotAChildClass/anything`,
      {}
    );
    expect(res.status).toBe(404);
  });

  // ── The viable path for getSubAgentByName ───────────────────────
  //
  // Context: we *tried* returning the facet stub directly from a
  // parent RPC method (`getChildStub` on `SpikeSubParent`). That
  // path throws at RPC-return time — DurableObject stubs (facet or
  // top-level) aren't structured-cloneable, so the runtime refuses.
  // We also considered an RpcTarget wrapper that holds the stub and
  // proxies `invoke(method, args)` calls; RpcTarget *does* cross the
  // boundary, but its lifetime is tied to the RPC call that returned
  // it, so it can't be reused across separate calls.
  //
  // The approach that actually works is a stateless per-call bridge:
  // the parent exposes one RPC method (`invokeSubAgent`) that
  // resolves the facet via `this.subAgent(...)` and dispatches each
  // time. The caller-side `getSubAgentByName` wraps this in a JS
  // Proxy so users get a natural `.method(...)` API.
  //
  // Cost: one extra RPC hop per call. Benefit: works across
  // hibernation, no reference lifetimes, and the public API stays
  // exactly as the RFC describes.
  //
  // We can't hand a facet stub (or any DO stub) back across RPC.
  // We also can't cache an RpcTarget reference across separate RPC
  // calls (the reference dies with its originating call context).
  //
  // The pattern that *does* work is a stateless per-call bridge:
  // the parent exposes one method (`invokeSubAgent(name, method,
  // args)`) that resolves the facet and dispatches each time. The
  // caller-side `getSubAgentByName` wraps this in a JS Proxy so
  // users get a natural `.method(...)` API on top of one-hop-per-
  // call RPC.
  describe("Stateless per-call bridge — the getSubAgentByName implementation", () => {
    it("invokes a method on the facet via the parent bridge", async () => {
      const parent = uniqueName();
      const child = uniqueName();

      const parentStub = await getAgentByName(env.SpikeSubParent, parent);

      const count = (await parentStub.invokeSubAgent(child, "getCount", [
        "anything"
      ])) as number;
      expect(count).toBe(0);

      await parentStub.invokeSubAgent(child, "resetCounts", []);

      const after = (await parentStub.invokeSubAgent(child, "getCount", [
        "anything"
      ])) as number;
      expect(after).toBe(0);
    });

    it("bridge observes state mutated via the WS path", async () => {
      const parent = uniqueName();
      const child = uniqueName();

      const ws = await openWS(parent, "SpikeSubChild", child);
      ws.send("warmup");
      await collectMessages(ws, 1);
      ws.close();

      const parentStub = await getAgentByName(env.SpikeSubParent, parent);

      const connects = (await parentStub.invokeSubAgent(child, "getCount", [
        "connect"
      ])) as number;
      const messages = (await parentStub.invokeSubAgent(child, "getCount", [
        "message"
      ])) as number;

      expect(connects).toBeGreaterThanOrEqual(1);
      expect(messages).toBeGreaterThanOrEqual(1);
    });

    it("a JS Proxy over the bridge gives ergonomic typed access", async () => {
      // This is what `getSubAgentByName` would return to the user.
      // The caller writes `chat.getCount(...)` instead of
      // `parent.invokeSubAgent(name, "getCount", [...])`.
      const parent = uniqueName();
      const child = uniqueName();

      const parentStub = await getAgentByName(env.SpikeSubParent, parent);

      const chat = new Proxy(
        {},
        {
          get: (_, method: string | symbol) => {
            if (typeof method !== "string") return undefined;
            // Thenable guard: `await chat` shouldn't try to call a
            // .then() that doesn't exist on the child.
            if (method === "then") return undefined;
            return async (...args: unknown[]) =>
              parentStub.invokeSubAgent(child, method, args);
          }
        }
      ) as {
        getCount(key: string): Promise<number>;
        resetCounts(): Promise<void>;
      };

      await chat.resetCounts();
      expect(await chat.getCount("anything")).toBe(0);
    });

    it("survives multiple independent top-level calls (no reference lifetime issue)", async () => {
      const parent = uniqueName();
      const child = uniqueName();

      const parentStub = await getAgentByName(env.SpikeSubParent, parent);

      // Unlike the RpcTarget approach, each call is a fresh RPC —
      // no cached reference to go stale.
      for (let i = 0; i < 5; i++) {
        const n = (await parentStub.invokeSubAgent(child, "getCount", [
          "anything"
        ])) as number;
        expect(n).toBeGreaterThanOrEqual(0);
      }
    });
  });
});
