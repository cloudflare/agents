import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Fast, in-isolate coverage of the worker's HTTP surface (src/index.ts default
// fetch). These paths run entirely inside the isolate — no container, no
// network — so they're safe and quick here. Anything that would submit a Think
// turn (which needs the "container" backend that miniflare can't boot) is left
// to the e2e suite. SELF drives the real worker exactly as deployed, with the
// real bindings from wrangler.jsonc.
describe("agent-think HTTP surface", () => {
  it("GET / serves the command-center SPA (assets layer)", async () => {
    // The root is the command center: `/` is not in run_worker_first, so the
    // assets layer serves the built index.html directly and the SPA routes
    // client-side. An operator hitting the root URL gets the dashboard.
    const res = await SELF.fetch("https://agent-think.test/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain('<div id="root">');
  });

  it("returns 404 for an unknown path (no ingress over HTTP)", async () => {
    // There is intentionally no issue ingress over plain HTTP — only `/`,
    // `/thread/*`, the `/agents/*` transport, and (dev-only) `/dev/*`. Anything
    // else must fall through to the worker's explicit not-found.
    const res = await SELF.fetch(
      "https://agent-think.test/definitely/not/a/route"
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");
  });

  it("/dev/* is closed in the test env (LOCAL_DEV unset)", async () => {
    // The dev trigger is gated on LOCAL_DEV === "1", which this config does not
    // set. So /dev/dispatch must NOT be treated as a dispatch route; it falls
    // through to the 404 tail like any other unknown path. This guards the
    // "prod deploy sets no LOCAL_DEV, so these 404 there" invariant without
    // needing a container.
    const res = await SELF.fetch("https://agent-think.test/dev/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "cloudflare/agents", issueNumber: 1 })
    });
    expect(res.status).toBe(404);
  });

  it("rejects cross-origin command-center continuation requests", async () => {
    const res = await SELF.fetch(
      "https://agent-think.test/api/command-center/continue/cloudflare-agents-1",
      {
        method: "POST",
        headers: { origin: "https://attacker.example" }
      }
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 when continuing an unknown command-center session", async () => {
    const res = await SELF.fetch(
      "https://agent-think.test/api/command-center/continue/cloudflare-agents-1",
      {
        method: "POST",
        headers: { origin: "https://agent-think.test" }
      }
    );
    expect(res.status).toBe(404);
  });

  it("GET /thread/:session is handled by the SPA fallback (not the 404 tail)", async () => {
    // /thread/* is a client-side route: the worker serves index.html and lets
    // the React app read the session from the path. We assert it's *handled*
    // rather than pinning an exact status — under miniflare the ASSETS binding
    // may or may not surface the built index.html, but either way this must not
    // be the generic "not found" 404 that unknown paths get. That distinction
    // is the real routing contract; the body/asset plumbing is an e2e concern.
    const res = await SELF.fetch(
      "https://agent-think.test/thread/cloudflare-agents-123"
    );
    expect(res.status).not.toBe(404);
    // When the asset layer does serve it, it's HTML — assert that shape only if
    // we actually got a 2xx, so a bare test env without built assets doesn't
    // make this brittle.
    if (res.ok) {
      expect(res.headers.get("content-type")).toContain("text/html");
    }
  });
});
