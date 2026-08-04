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
import {
  buildSubAgentPath,
  validateRootAgentNameSegment
} from "../sub-routing";

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

  it("builds a routable OAuth callback URL for a sub-agent", async () => {
    const parent = uniqueName();
    const child = uniqueName();
    const parentStub = await getAgentByName(env.TestSubAgentParent, parent);

    const authUrl = new URL(await parentStub.startSubAgentOAuth(child));

    expect(authUrl.origin + authUrl.pathname).toBe(
      "https://auth.example.com/authorize"
    );
    expect(authUrl.searchParams.get("redirect_uri")).toBe(
      `https://app.example.com/agents/test-sub-agent-parent/${parent}/sub/o-auth-callback-sub-agent/${child}/callback`
    );
  });

  it("routes an OAuth callback when the root name contains percent escapes", async () => {
    const parent = `root%2F${uniqueName()}`;
    const child = uniqueName();
    const parentStub = await getAgentByName(env.TestSubAgentParent, parent);
    const authUrl = new URL(await parentStub.startSubAgentOAuth(child));
    const callbackUrl = new URL(authUrl.searchParams.get("redirect_uri")!);
    callbackUrl.searchParams.set("error", "access_denied");
    callbackUrl.searchParams.set("state", authUrl.searchParams.get("state")!);

    const response = await exports.default.fetch(new Request(callbackUrl));

    expect(response.status).toBe(401);
  });

  it("routes an OAuth callback to the sub-agent that started the flow", async () => {
    const parent = uniqueName();
    const child = uniqueName();
    const parentStub = await getAgentByName(env.TestSubAgentParent, parent);
    const authUrl = new URL(await parentStub.startSubAgentOAuth(child));
    const callbackUrl = new URL(authUrl.searchParams.get("redirect_uri")!);
    callbackUrl.searchParams.set("error", "access_denied");
    callbackUrl.searchParams.set("state", authUrl.searchParams.get("state")!);

    const response = await exports.default.fetch(
      new Request(callbackUrl, { redirect: "manual" })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      serverId: authUrl.searchParams.get("state")!.split(".")[1],
      success: false
    });
  });

  it("routes a custom OAuth callback through a structured path", async () => {
    const parent = uniqueName();
    const child = uniqueName();
    const parentStub = await getAgentByName(env.TestSubAgentParent, parent);
    const authUrl = new URL(
      await parentStub.startSubAgentOAuth(child, "/oauth/callback")
    );
    const callbackUrl = new URL(authUrl.searchParams.get("redirect_uri")!);
    callbackUrl.searchParams.set("error", "access_denied");
    callbackUrl.searchParams.set("state", authUrl.searchParams.get("state")!);
    const { routeSubAgentRequest } = await import("../index");

    const response = await routeSubAgentRequest(
      new Request(callbackUrl),
      parentStub,
      {
        fromPath: {
          path: [{ className: "OAuthCallbackSubAgent", name: child }],
          leaf: "/callback"
        }
      }
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ success: false });
  });

  it("ignores a malformed internal outer-URL header", async () => {
    const parentStub = await getAgentByName(
      env.TestSubAgentParent,
      uniqueName()
    );

    const response = await parentStub.fetch(
      new Request(
        `https://app.example.com/sub/counter-sub-agent/${uniqueName()}/request`,
        { headers: { "x-cf-agents-subagent-url": "not a URL" } }
      )
    );

    expect(response.status).toBe(404);
  });

  it("allows ordinary facet HTTP paths containing a sub segment", async () => {
    const parent = uniqueName();
    const child = uniqueName();

    const response = await exports.default.fetch(
      new Request(
        `https://app.example.com/agents/test-sub-agent-parent/${parent}/sub/outer-sub-agent/${child}/api/sub/items/42`
      )
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      agentName: child,
      path: "/api/sub/items/42"
    });
  });

  it("does not take OAuth parameters from the internal outer-URL header", async () => {
    const parent = uniqueName();
    const child = uniqueName();
    const parentStub = await getAgentByName(env.TestSubAgentParent, parent);
    const authUrl = new URL(
      await parentStub.startSubAgentOAuth(child, "/oauth/callback")
    );
    const state = authUrl.searchParams.get("state")!;
    const internalUrl = new URL(
      `https://app.example.com/sub/o-auth-callback-sub-agent/${child}/callback`
    );
    internalUrl.searchParams.set("error", "access_denied");
    internalUrl.searchParams.set("state", state);

    const response = await parentStub.fetch(
      new Request(internalUrl, {
        headers: {
          "x-cf-agents-subagent-url":
            "https://app.example.com/oauth/callback?state=forged.invalid"
        }
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      serverId: state.split(".")[1],
      success: false
    });
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

  it("getSubAgentByName proxy does not fire ghost RPCs on JS-internal probes", async () => {
    // JSON.stringify, console.log inspection, Vitest matchers, and
    // other runtime/test-framework operations probe a known set of
    // JS-internal property names. Each of these must return
    // `undefined` from the Proxy — never dispatch an RPC that would
    // fail with "Method not found" on the child.
    const parent = uniqueName();
    const child = uniqueName();
    const parentStub = await getAgentByName(env.TestSubAgentParent, parent);

    const stub = (await getSubAgentByName(
      parentStub,
      CounterSubAgentShim,
      child
    )) as unknown as Record<string, unknown>;

    const internalProps = [
      "toJSON",
      "then",
      "catch",
      "finally",
      "valueOf",
      "toString",
      "constructor",
      "prototype",
      "$$typeof",
      "@@toStringTag",
      "asymmetricMatch",
      "nodeType"
    ];

    for (const p of internalProps) {
      expect(
        stub[p],
        `probing ${p} should not return a function`
      ).toBeUndefined();
    }

    // JSON.stringify would call `toJSON()` if it existed; with the
    // guard in place it sees `undefined` and falls through to
    // enumerable-property walking (no own props on a Proxy over `{}`,
    // so the result is `"{}"`).
    expect(JSON.stringify(stub)).toBe("{}");

    // And the real method still works after we've probed internals.
    expect(await (stub as unknown as { ping(): Promise<string> }).ping()).toBe(
      "pong"
    );
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

describe("buildSubAgentPath", () => {
  it("builds a nested route and leaf path", () => {
    expect(
      buildSubAgentPath(
        [
          { className: "Chat", name: "chat/a" },
          { className: "ThreadAgent", name: "thread one" }
        ],
        "/callback"
      )
    ).toBe("/sub/chat/chat%2Fa/sub/thread-agent/thread%20one/callback");
  });

  it("defaults the leaf path to the routed sub-agent root", () => {
    expect(buildSubAgentPath([{ className: "Chat", name: "chat-a" }])).toBe(
      "/sub/chat/chat-a"
    );
  });

  it.each(["", ".", ".."])("rejects the non-routable name %j", (name) => {
    expect(() => buildSubAgentPath([{ className: "Chat", name }])).toThrow(
      /not externally routable/
    );
  });

  it("rejects a sub-agent class that collides with the route separator", () => {
    expect(() =>
      buildSubAgentPath([{ className: "Sub", name: "child" }])
    ).toThrow(/reserved/);
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

  it("ignores earlier non-marker 'sub' segments (parent instance named 'sub')", () => {
    // Parent instance is literally named "sub". Naive indexOf("sub")
    // would pick parts[2] (the instance name) and try to resolve
    // parts[3] = "sub" as a class, which isn't known → null.
    // The correct behavior is to keep walking and pin the real
    // marker at parts[3], followed by the real child class at
    // parts[4].
    const m = parseSubAgentPath("http://x/agents/inbox/sub/sub/chat/abc", {
      knownClasses: ["Inbox", "Chat"]
    });
    expect(m).toEqual({
      childClass: "Chat",
      childName: "abc",
      remainingPath: "/"
    });
  });

  it("ignores earlier non-marker 'sub' in a basePath segment", () => {
    // A basePath like `/subscriptions/` would contain `sub` before
    // the real `/sub/` marker. The walk must find the real one.
    const m = parseSubAgentPath(
      "http://x/subscriptions/agents/inbox/alice/sub/chat/abc",
      { knownClasses: ["Inbox", "Chat"] }
    );
    expect(m).toEqual({
      childClass: "Chat",
      childName: "abc",
      remainingPath: "/"
    });
  });

  it("matches the first valid marker when multiple candidates appear", () => {
    // Nested path: `/agents/inbox/alice/sub/chat/room-1/sub/thread/t1`.
    // Parsing at the root returns the outermost hop (Chat/room-1).
    // The inner hop is in remainingPath and gets parsed by the
    // child's own fetch on the next level.
    const m = parseSubAgentPath(
      "http://x/agents/inbox/alice/sub/chat/room-1/sub/thread/t1",
      { knownClasses: ["Inbox", "Chat", "Thread"] }
    );
    expect(m).toEqual({
      childClass: "Chat",
      childName: "room-1",
      remainingPath: "/sub/thread/t1"
    });
  });
});

describe("routeSubAgentRequest — query-param preservation", () => {
  it("rejects an empty structured path", async () => {
    const { routeSubAgentRequest } = await import("../index");
    const response = await routeSubAgentRequest(
      new Request("https://app.example.com/callback"),
      { fetch: () => Promise.reject(new Error("should not forward")) },
      { fromPath: { path: [] } }
    );

    expect(response.status).toBe(400);
  });

  it("returns 400 for an invalid structured path step", async () => {
    const { routeSubAgentRequest } = await import("../index");
    const response = await routeSubAgentRequest(
      new Request("https://app.example.com/callback"),
      { fetch: () => Promise.reject(new Error("should not forward")) },
      { fromPath: { path: [{ className: "Sub", name: "child" }] } }
    );

    expect(response.status).toBe(400);
  });

  it("treats an empty string path as omitted", async () => {
    const { routeSubAgentRequest } = await import("../index");
    let forwardedUrl: string | undefined;
    const response = await routeSubAgentRequest(
      new Request("https://app.example.com/sub/chat/child?code=test"),
      {
        fetch: (request: Request) => {
          forwardedUrl = request.url;
          return Promise.resolve(new Response(null, { status: 204 }));
        }
      },
      { fromPath: "" }
    );

    expect(response.status).toBe(204);
    expect(forwardedUrl).toBe(
      "https://app.example.com/sub/chat/child?code=test"
    );
  });

  it.each(["%2e", "%2e%2e", "has/slash", "has?query", "has#fragment"])(
    "rejects the non-routable root name %j",
    (name) => {
      expect(() => validateRootAgentNameSegment(name)).toThrow(
        /not externally routable/
      );
    }
  );

  it("does not disturb unmatched request bodies", async () => {
    const { routeAgentRequest } = await import("../index");
    const request = new Request("https://app.example.com/not-an-agent", {
      method: "POST",
      headers: { "x-cf-agents-subagent-url": "https://forged.example.com" },
      body: "fallback body"
    });

    expect(await routeAgentRequest(request, env)).toBeNull();
    await expect(request.text()).resolves.toBe("fallback body");
  });

  it("rejects a matched request with an already-used body before cloning", async () => {
    const { routeAgentRequest } = await import("../index");
    const request = new Request(
      `https://app.example.com/agents/test-sub-agent-parent/${uniqueName()}`,
      {
        method: "POST",
        headers: {
          "x-cf-agents-subagent-url": "https://forged.example.com"
        },
        body: "already read"
      }
    );
    await request.text();

    const response = await routeAgentRequest(request, env);
    expect(response?.status).toBe(400);
  });

  it("does not clone an unmatched request with an already-used body", async () => {
    const { routeAgentRequest } = await import("../index");
    const request = new Request("https://app.example.com/not-an-agent", {
      method: "POST",
      headers: { "x-cf-agents-subagent-url": "https://forged.example.com" },
      body: "already read"
    });
    await request.text();

    expect(await routeAgentRequest(request, env)).toBeNull();
  });

  it("accepts a structured sub-agent path", async () => {
    const parent = uniqueName();
    const child = "chat/with space";
    const parentStub = await getAgentByName(env.HookingSubAgentParent, parent);
    await parentStub.setHookMode("allow");
    const { routeSubAgentRequest } = await import("../index");

    await routeSubAgentRequest(
      new Request("https://app.example.com/oauth/callback?code=test"),
      parentStub,
      {
        fromPath: {
          path: [{ className: "CounterSubAgent", name: child }],
          leaf: "/callback"
        }
      }
    );

    const observed = new URL((await parentStub.lastObservedUrl())!);
    expect(observed.pathname).toBe(
      "/sub/counter-sub-agent/chat%2Fwith%20space/callback"
    );
    expect(observed.search).toBe("?code=test");
  });

  it("preserves original request query params when `fromPath` is used", async () => {
    // Custom-routing worker handler at worker.ts:/custom-sub/...
    // extracts `rest` from the pathname (no query). Without a fix,
    // `routeSubAgentRequest({ fromPath: rest })` constructs the
    // forward URL via `new URL(fromPath, req.url)` which drops the
    // base's search. The parent would then see a URL with no query.
    const parent = uniqueName();
    const child = uniqueName();

    const parentStub = await getAgentByName(env.HookingSubAgentParent, parent);
    await parentStub.setHookMode("allow");

    await exports.default.fetch(
      `http://x/custom-sub/${parent}/sub/counter-sub-agent/${child}/anything?token=xyz&flag=1`
    );

    const observed = await parentStub.lastObservedUrl();
    expect(observed).not.toBeNull();
    const observedUrl = new URL(observed!);
    expect(observedUrl.searchParams.get("token")).toBe("xyz");
    expect(observedUrl.searchParams.get("flag")).toBe("1");
    // Pathname is rewritten to `rest` (without the /custom-sub prefix).
    expect(observedUrl.pathname).toBe(
      `/sub/counter-sub-agent/${child}/anything`
    );
  });

  it("lets `fromPath`'s own query string override the original", async () => {
    // Edge case: if a caller explicitly builds a fromPath with
    // `?k=v`, that should win over whatever was on the original
    // request. Matches standard URL-rewrite semantics.
    const parent = uniqueName();
    const child = uniqueName();

    const parentStub = await getAgentByName(env.HookingSubAgentParent, parent);
    await parentStub.setHookMode("allow");

    // `custom-sub-query` is a variant handler (below) that passes a
    // fromPath with its own query string. We inline the invocation
    // via the helper directly rather than adding a new worker route —
    // `routeSubAgentRequest` is already importable, and we have a
    // parent stub.
    const { routeSubAgentRequest } = await import("../index");
    const req = new Request(`http://x/unused?original=keep`);
    await routeSubAgentRequest(req, parentStub, {
      fromPath: `/sub/counter-sub-agent/${child}/?overridden=yes`
    });

    const observed = await parentStub.lastObservedUrl();
    expect(observed).not.toBeNull();
    const observedUrl = new URL(observed!);
    // fromPath's query wins, original is dropped.
    expect(observedUrl.searchParams.get("overridden")).toBe("yes");
    expect(observedUrl.searchParams.has("original")).toBe(false);
  });
});

describe("sub-agent routing — error bodies", () => {
  it("returns a terse 'Bad Request' body (no implementation leak) when the child name contains a null char", async () => {
    // `%00` in a URL decodes to `\0`, which `_cf_resolveSubAgent`
    // rejects. The class is known (passes the strict filter in the
    // parent's fetch override) so routing reaches the bridge — and
    // the resulting 400 body must be the scrubbed string, not the
    // internal error text.
    const parent = uniqueName();
    const parentStub = await getAgentByName(env.HookingSubAgentParent, parent);
    await parentStub.setHookMode("allow");

    const evilName = encodeURIComponent("abc\0def");
    const res = await exports.default.fetch(
      `http://x/custom-sub/${parent}/sub/counter-sub-agent/${evilName}/anything`
    );
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toBe("Bad Request");
    // Internal error strings must not leak over the wire.
    expect(body).not.toMatch(/null character|reserved|ctx\.exports/i);
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
