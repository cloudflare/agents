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
});
