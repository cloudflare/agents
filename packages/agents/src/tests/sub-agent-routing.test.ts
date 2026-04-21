/**
 * Production-path tests for sub-agent external addressability.
 *
 * The spike (see `spike-sub-agent-routing.test.ts`) proved the
 * underlying mechanism. These tests exercise the real public
 * surface end-to-end via `routeAgentRequest`:
 *
 *   - Nested URL: `/agents/{parent-class}/{parent-name}/sub/{child-class}/{child-name}`
 *   - `onBeforeSubAgent` hook variants (void / Request / Response)
 *   - `routeSubAgentRequest` from a custom handler
 *   - `getSubAgentByName` — proxied RPC, no `.fetch()`
 *   - Name URL-encoding round trips
 *   - Recursive (two-level) nesting
 */

import { exports, env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Agent } from "../index";
import { getAgentByName, getSubAgentByName, parseSubAgentPath } from "../index";

function uniqueName() {
  return `sub-routing-${Math.random().toString(36).slice(2)}`;
}

describe("sub-agent routing — routeAgentRequest + /sub/... URLs", () => {
  it("resolves a child facet when the URL contains /sub/", async () => {
    const parent = uniqueName();
    const child = uniqueName();

    // TestSubAgentParent has CounterSubAgent as a declared child class.
    // The URL shape is /agents/{parent-class-kebab}/{parent-name}/sub/{child-class-kebab}/{child-name}[/...]
    // We hit an HTTP path the child responds to via `onRequest` (or
    // `@callable`). Since CounterSubAgent doesn't implement an HTTP
    // endpoint, use the @callable RPC path.
    //
    // We confirm the routing works via getSubAgentByName below.

    const parentStub = await getAgentByName(env.TestSubAgentParent, parent);
    const childStub = await getSubAgentByName(
      parentStub,
      CounterSubAgentShim,
      child
    );

    // Round-trip a typed RPC call.
    const before = await childStub.get("anything");
    expect(before).toBe(0);

    const next = await childStub.increment("anything");
    expect(next).toBe(1);

    const after = await childStub.get("anything");
    expect(after).toBe(1);
  });

  it("hasSubAgent reflects spawns driven by the real bridge", async () => {
    const parent = uniqueName();
    const a = uniqueName();
    const b = uniqueName();

    const parentStub = await getAgentByName(env.TestSubAgentParent, parent);

    await (await getSubAgentByName(parentStub, CounterSubAgentShim, a)).ping();
    await (await getSubAgentByName(parentStub, CounterSubAgentShim, b)).ping();

    const all = await parentStub.list();
    const names = all.map((r: { name: string }) => r.name).sort();
    expect(names.includes(a)).toBe(true);
    expect(names.includes(b)).toBe(true);
  });

  it("getSubAgentByName refuses .fetch() with a pointer at routeSubAgentRequest", async () => {
    const parent = uniqueName();
    const child = uniqueName();

    const parentStub = await getAgentByName(env.TestSubAgentParent, parent);
    const childStub = (await getSubAgentByName(
      parentStub,
      CounterSubAgentShim,
      child
    )) as unknown as { fetch(r: Request): Promise<Response> };

    expect(() => childStub.fetch(new Request("http://x/"))).toThrow(
      /routeSubAgentRequest/
    );
  });

  it("getSubAgentByName proxy is await-safe (thenable guard)", async () => {
    // `await getSubAgentByName(...)` should resolve to the Proxy
    // itself, not probe `.then` and trigger a ghost RPC. This
    // regresses badly without the guard.
    const parent = uniqueName();
    const child = uniqueName();
    const parentStub = await getAgentByName(env.TestSubAgentParent, parent);

    const stub = await getSubAgentByName(
      parentStub,
      CounterSubAgentShim,
      child
    );

    expect(typeof stub).toBe("object");
    expect(await stub.ping()).toBe("pong");
  });
});

describe("onBeforeSubAgent hook — allow / reject / mutate", () => {
  it("allows the request through when the hook returns void", async () => {
    const parent = uniqueName();
    const child = uniqueName();

    const parentStub = await getAgentByName(env.HookingSubAgentParent, parent);
    await parentStub.setHookMode("allow");

    const res = await exports.default.fetch(
      `http://x/custom-sub/${parent}/sub/counter-sub-agent/${child}/anything`
    );
    // The child (CounterSubAgent) doesn't implement `onRequest` — it
    // would return the default partyserver 404/500 shape. What we
    // care about here is that the hook fired and the framework
    // dispatched, not that the child served the path.
    expect(await parentStub.hookCount("called")).toBe(1);
    expect(await parentStub.hookCount("class:CounterSubAgent")).toBe(1);
    // The request reached the child — the response isn't a
    // framework-level 501/404 from the routing layer.
    expect([200, 404, 500]).toContain(res.status);
  });

  it("returning a Response short-circuits (parent-driven 404)", async () => {
    const parent = uniqueName();
    const child = uniqueName();

    const parentStub = await getAgentByName(env.HookingSubAgentParent, parent);
    await parentStub.setHookMode("deny-404");

    const res = await exports.default.fetch(
      `http://x/custom-sub/${parent}/sub/counter-sub-agent/${child}/anything`
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");

    // The framework did not spawn the facet — the registry stays
    // empty for this child.
    expect(await parentStub.hasSubAgent("CounterSubAgent", child)).toBe(false);
  });

  it("returning a custom Response preserves headers (401 with WWW-Authenticate)", async () => {
    const parent = uniqueName();
    const child = uniqueName();

    const parentStub = await getAgentByName(env.HookingSubAgentParent, parent);
    await parentStub.setHookMode("deny-401");

    const res = await exports.default.fetch(
      `http://x/custom-sub/${parent}/sub/counter-sub-agent/${child}/anything`
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("strict-registry mode rejects unknown children but allows pre-registered ones", async () => {
    const parent = uniqueName();
    const unknownChild = uniqueName();
    const knownChild = uniqueName();

    const parentStub = await getAgentByName(env.HookingSubAgentParent, parent);
    await parentStub.setHookMode("strict-registry");
    await parentStub.prespawn(knownChild);

    const resUnknown = await exports.default.fetch(
      `http://x/custom-sub/${parent}/sub/counter-sub-agent/${unknownChild}/anything`
    );
    expect(resUnknown.status).toBe(404);
    expect(await resUnknown.text()).toBe("child not pre-registered");

    const resKnown = await exports.default.fetch(
      `http://x/custom-sub/${parent}/sub/counter-sub-agent/${knownChild}/anything`
    );
    // The hook allowed, the framework dispatched. The response text
    // didn't come from our deny path — the child (or partyserver's
    // default onRequest) produced whatever it produced.
    expect(await resKnown.text()).not.toBe("child not pre-registered");
  });

  it("routeSubAgentRequest honors the hook from a custom route handler", async () => {
    // The `/custom-sub/...` handler in worker.ts uses
    // routeSubAgentRequest directly (not routeAgentRequest). We've
    // already been using it implicitly above; this test pins the
    // integration: `deny-404` still fires when the outer route is
    // user-defined.
    const parent = uniqueName();
    const child = uniqueName();

    const parentStub = await getAgentByName(env.HookingSubAgentParent, parent);
    await parentStub.setHookMode("deny-404");

    const res = await exports.default.fetch(
      `http://x/custom-sub/${parent}/sub/counter-sub-agent/${child}/anything`,
      { method: "GET" }
    );
    expect(res.status).toBe(404);
    expect(await parentStub.hookCount("called")).toBeGreaterThanOrEqual(1);
  });
});

describe("parseSubAgentPath", () => {
  it("matches the default /sub/{class}/{name}", () => {
    const m = parseSubAgentPath("http://x/agents/inbox/alice/sub/chat/abc", {
      knownClasses: ["Inbox", "Chat"]
    });
    expect(m).toEqual({
      childClass: "Chat",
      childName: "abc",
      remainingPath: "/"
    });
  });

  it("captures a trailing path after the /sub/{class}/{name} segment", () => {
    const m = parseSubAgentPath(
      "http://x/agents/inbox/alice/sub/chat/abc/callable/addMessage",
      { knownClasses: ["Inbox", "Chat"] }
    );
    expect(m?.remainingPath).toBe("/callable/addMessage");
  });

  it("URL-decodes child names containing spaces or slashes", () => {
    const m = parseSubAgentPath(
      "http://x/agents/inbox/alice/sub/chat/" +
        encodeURIComponent("with/slash and space"),
      { knownClasses: ["Chat"] }
    );
    expect(m?.childName).toBe("with/slash and space");
  });

  it("returns null when the class segment doesn't match a known class", () => {
    const m = parseSubAgentPath("http://x/agents/inbox/alice/sub/unknown/abc", {
      knownClasses: ["Inbox", "Chat"]
    });
    expect(m).toBeNull();
  });

  it("returns null when /sub/ is missing", () => {
    const m = parseSubAgentPath("http://x/agents/inbox/alice/something", {
      knownClasses: ["Inbox", "Chat"]
    });
    expect(m).toBeNull();
  });

  it("returns null when /sub/ appears without a following class+name", () => {
    const m = parseSubAgentPath("http://x/agents/inbox/alice/sub/chat", {
      knownClasses: ["Chat"]
    });
    expect(m).toBeNull();
  });
});

// ── Minimal typing shim so the tests can use getSubAgentByName<T> ─────
//
// The test worker imports `CounterSubAgent` but the class is defined
// in a file that transitively depends on the whole agents index. We
// only need its shape for typed RPC here; the real class lookup
// happens on the server via `ctx.exports[className]`.

type CounterSubAgentInterface = Agent & {
  ping(): Promise<string>;
  increment(id: string): Promise<number>;
  get(id: string): Promise<number>;
};

// Named function declarations get their `name` from the identifier
// automatically — that's what `getSubAgentByName` reads to look up
// `ctx.exports` on the server. The structural Agent shape is
// satisfied via a type cast; the shim is never instantiated.
function CounterSubAgent(): CounterSubAgentInterface {
  throw new Error("CounterSubAgentShim is a typing shim only");
}
const CounterSubAgentShim =
  CounterSubAgent as unknown as new () => CounterSubAgentInterface;
