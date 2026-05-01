/**
 * Spike tests for sub-agent external addressability.
 *
 * Proves that a facet (created via `subAgent()` and obtained via
 * `ctx.facets.get()`) is reachable via a double-hop `fetch()` chain
 * — Worker → parent DO → facet Fetcher — for both WebSocket upgrades
 * and regular HTTP.
 *
 * Critical invariant we verify: the parent owns the browser
 * WebSocket transport, but sub-agent gates still run only at
 * connection time. Subsequent frames are forwarded to the target
 * child over RPC without re-running the gate per message.
 */

import { exports, env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName, getSubAgentByName } from "../index";
import { SpikeSubChild } from "./agents/spike-sub-agent-routing";

function uniqueName() {
  return `spike-${Math.random().toString(36).slice(2)}`;
}

/**
 * Class segment uses kebab-case — same convention as the top-level
 * `routeAgentRequest` / `useAgent` URLs. The framework resolves
 * back to the CamelCase entry in `ctx.exports`.
 */
async function connectViaSpike(
  parent: string,
  childClass: string,
  child: string,
  suffix = ""
) {
  const url = `http://example.com/spike-sub/${parent}/sub/${childClass}/${child}${suffix}`;
  const res = await exports.default.fetch(url, {
    headers: { Upgrade: "websocket" }
  });
  return { res };
}

async function openWS(
  parent: string,
  childClass: string,
  child: string,
  suffix = ""
): Promise<WebSocket> {
  const { res } = await connectViaSpike(parent, childClass, child, suffix);
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

    const ws = await openWS(parent, "spike-sub-child", child);

    ws.send("hello");
    const [reply] = await collectMessages(ws, 1);
    expect(reply).toBe(`pong:${child}:hello`);

    ws.close();
  });

  it("this.broadcast(...) inside a facet reaches the facet's own WS clients", async () => {
    // Regression: an earlier guard in Agent.broadcast() no-op'd when
    // `_isFacet` was set, assuming facets had no direct client
    // sockets. Sub-agent routing broke that assumption — clients
    // connect directly to facets via `/sub/{class}/{name}`. The
    // guard made `AIChatAgent._broadcastChatMessage` silently drop
    // every streaming chunk to the client, so real-time chat
    // updates required a page refresh to pick up persisted messages.
    const parent = uniqueName();
    const child = uniqueName();

    const ws = await openWS(parent, "spike-sub-child", child);
    ws.send("broadcast:hello");

    const [reply] = await collectMessages(ws, 1);
    expect(reply).toBe(`pong:${child}:broadcast:hello`);

    ws.close();
  });

  it("this.broadcast(...) from child RPC reaches child-targeted WS clients", async () => {
    const parent = uniqueName();
    const child = uniqueName();

    const ws = await openWS(parent, "spike-sub-child", child);
    const parentStub = await getAgentByName(env.SpikeSubParent, parent);
    const childStub = await getSubAgentByName(parentStub, SpikeSubChild, child);

    await childStub.broadcastFromChild("hello");
    const [reply] = await collectMessages(
      ws,
      1,
      (data) => typeof data === "string" && data.startsWith("child:")
    );
    expect(reply).toBe(`child:${child}:hello`);

    ws.close();
  });

  it("parent broadcasts do not leak onto child-targeted sockets", async () => {
    const parent = uniqueName();
    const child = uniqueName();

    const ws = await openWS(parent, "spike-sub-child", child);
    const parentStub = await getAgentByName(env.SpikeSubParent, parent);

    await parentStub.broadcastFromParent("hello");
    const leaked = await collectMessages(
      ws,
      1,
      (data) => typeof data === "string" && data.startsWith("parent:"),
      200
    );
    expect(leaked).toHaveLength(0);

    ws.close();
  });

  it("exposes child-targeted sockets through child getConnection APIs with child tags", async () => {
    const parent = uniqueName();
    const child = uniqueName();

    const ws = await openWS(parent, "spike-sub-child", child, "?tag=child-tag");
    ws.send("snapshot");
    const [reply] = await collectMessages(
      ws,
      1,
      (data) => typeof data === "string" && data.startsWith("snapshot:")
    );
    const snapshot = JSON.parse(reply.slice("snapshot:".length)) as {
      all: Array<{ id: string; tags: string[] }>;
      tagged: string[];
    };

    expect(snapshot.all).toHaveLength(1);
    expect(snapshot.all[0]?.tags).toContain("child-tag");
    expect(snapshot.tagged).toEqual([snapshot.all[0]?.id]);

    const parentStub = await getAgentByName(env.SpikeSubParent, parent);
    const childStub = await getSubAgentByName(parentStub, SpikeSubChild, child);
    const rpcSnapshot = await childStub.connectionSnapshot("child-tag");
    expect(rpcSnapshot.all).toHaveLength(1);
    expect(rpcSnapshot.tagged).toEqual([snapshot.all[0]?.id]);

    ws.close();
  });

  it("rehydrates child connection APIs from the root-owned WebSocket state", async () => {
    const parent = uniqueName();
    const child = uniqueName();

    const ws = await openWS(parent, "spike-sub-child", child, "?tag=child-tag");
    const parentStub = await getAgentByName(env.SpikeSubParent, parent);
    const childStub = await getSubAgentByName(parentStub, SpikeSubChild, child);

    const snapshot =
      await childStub.rehydrateConnectionSnapshotForTest("child-tag");
    expect(snapshot.all).toHaveLength(1);
    expect(snapshot.all[0]?.tags).toContain("child-tag");
    expect(snapshot.tagged).toEqual([snapshot.all[0]?.id]);

    expect(await childStub.sendToFirstConnection("after-hydrate")).toBe(true);
    const [reply] = await collectMessages(
      ws,
      1,
      (data) => typeof data === "string" && data.startsWith("direct:")
    );
    expect(reply).toBe(`direct:${child}:after-hydrate`);

    ws.close();
  });

  it("preserves child readonly and no-protocol flags on later forwarded messages", async () => {
    const parent = uniqueName();
    const child = uniqueName();

    const ws = await openWS(
      parent,
      "spike-sub-child",
      child,
      "?readonly=1&protocol=0"
    );

    ws.send(JSON.stringify({ type: "cf_agent_state", state: { value: 1 } }));
    const [error] = await collectMessages(
      ws,
      1,
      (data) =>
        typeof data === "string" && data.includes("Connection is readonly")
    );
    expect(error).toContain("cf_agent_state_error");

    ws.send("snapshot");
    const [reply] = await collectMessages(
      ws,
      1,
      (data) => typeof data === "string" && data.startsWith("snapshot:")
    );
    const snapshot = JSON.parse(reply.slice("snapshot:".length)) as {
      all: Array<{ readonly: boolean; protocol: boolean }>;
    };
    expect(snapshot.all[0]?.readonly).toBe(true);
    expect(snapshot.all[0]?.protocol).toBe(false);

    ws.close();
  });

  it("routes subsequent frames to the child without re-running the parent gate", async () => {
    const parent = uniqueName();
    const child = uniqueName();

    // Reset the `onBeforeSubAgent` counter on the parent.
    const parentStub = await getAgentByName(env.SpikeSubParent, parent);
    await parentStub.resetCounts();

    const ws = await openWS(parent, "spike-sub-child", child);

    // Send a burst of messages. The parent owns the transport, but
    // `onBeforeSubAgent` is still a connect-time gate — it must not
    // re-run for every frame.
    const N = 10;
    for (let i = 0; i < N; i++) {
      ws.send(`msg-${i}`);
    }

    const replies = await collectMessages(ws, N);
    expect(replies).toHaveLength(N);
    const expected = new Set(
      Array.from({ length: N }, (_, i) => `pong:${child}:msg-${i}`)
    );
    expect(new Set(replies)).toEqual(expected);

    // Critical invariant: the parent's hook fired exactly once.
    const onBeforeCalls = await parentStub.getCount("on_before");
    expect(onBeforeCalls).toBe(1);

    ws.close();
  });

  it("forwards HTTP requests through the same chain", async () => {
    const parent = uniqueName();
    const child = uniqueName();

    const parentStub = await getAgentByName(env.SpikeSubParent, parent);
    await parentStub.resetCounts();

    const res = await exports.default.fetch(
      `http://example.com/spike-sub/${parent}/sub/spike-sub-child/${child}/anything`,
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
    // Path stripped of /sub/... prefix.
    expect(body.path).toBe("/anything");

    const onBeforeCalls = await parentStub.getCount("on_before");
    expect(onBeforeCalls).toBe(1);
  });

  it("isolates per-child state across different child names", async () => {
    const parent = uniqueName();
    const childA = uniqueName();
    const childB = uniqueName();

    const wsA = await openWS(parent, "spike-sub-child", childA);
    const wsB = await openWS(parent, "spike-sub-child", childB);

    // Register both listeners BEFORE sending. `addEventListener`
    // only hears future events — if we send first and attach
    // second, a reply that arrives in the window between the two
    // sends and the corresponding `await collectMessages` is
    // silently dropped, and the test times out. This bites
    // specifically when there are multiple sockets: awaiting
    // `collectMessages(wsA, 1)` yields, during which wsB's reply
    // may land before wsB's listener is attached.
    const replyAPromise = collectMessages(wsA, 1);
    const replyBPromise = collectMessages(wsB, 1);

    wsA.send("from-a");
    wsB.send("from-b");

    const [replyA] = await replyAPromise;
    const [replyB] = await replyBPromise;

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

  // ── getSubAgentByName — the real primitive ──────────────────────
  //
  // The spike previously explored three candidate designs for the
  // outside-RPC path (direct stub return, RpcTarget wrapper, per-call
  // bridge) and confirmed only the third works. Phase 2 landed the
  // per-call bridge as `_cf_invokeSubAgent` on the `Agent` base plus
  // `getSubAgentByName` as a JS Proxy on top. These tests exercise
  // the real primitive end-to-end.
  describe("getSubAgentByName — per-call bridge via Agent base", () => {
    it("typed RPC method calls round-trip via the parent bridge", async () => {
      const parent = uniqueName();
      const child = uniqueName();

      const parentStub = await getAgentByName(env.SpikeSubParent, parent);
      const childStub = await getSubAgentByName(
        parentStub,
        SpikeSubChild,
        child
      );

      expect(await childStub.getCount("anything")).toBe(0);
      await childStub.resetCounts();
      expect(await childStub.getCount("anything")).toBe(0);
    });

    it("observes state mutated via the WS path", async () => {
      const parent = uniqueName();
      const child = uniqueName();

      const ws = await openWS(parent, "spike-sub-child", child);
      ws.send("warmup");
      await collectMessages(ws, 1);
      ws.close();

      const parentStub = await getAgentByName(env.SpikeSubParent, parent);
      const childStub = await getSubAgentByName(
        parentStub,
        SpikeSubChild,
        child
      );

      expect(await childStub.getCount("connect")).toBeGreaterThanOrEqual(1);
      expect(await childStub.getCount("message")).toBeGreaterThanOrEqual(1);
    });

    it("survives multiple independent calls (no reference lifetime issue)", async () => {
      const parent = uniqueName();
      const child = uniqueName();

      const parentStub = await getAgentByName(env.SpikeSubParent, parent);
      const childStub = await getSubAgentByName(
        parentStub,
        SpikeSubChild,
        child
      );

      for (let i = 0; i < 5; i++) {
        expect(await childStub.getCount("anything")).toBeGreaterThanOrEqual(0);
      }
    });

    it(".fetch() is rejected with a helpful error pointing at routeSubAgentRequest", async () => {
      const parent = uniqueName();
      const child = uniqueName();

      const parentStub = await getAgentByName(env.SpikeSubParent, parent);
      const childStub = (await getSubAgentByName(
        parentStub,
        SpikeSubChild,
        child
      )) as unknown as {
        fetch(req: Request): Promise<Response>;
      };

      expect(() => childStub.fetch(new Request("http://x/anything"))).toThrow(
        /routeSubAgentRequest/
      );
    });
  });
});
