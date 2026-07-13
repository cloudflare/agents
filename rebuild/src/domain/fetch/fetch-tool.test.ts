import { describe, expect, it } from "vitest";
import { createMemoryFetch, type MemoryHttpResponse } from "../../adapters/memory/http.js";
import { createMemoryKeyValueStore } from "../../adapters/memory/store.js";
import { createTestClock } from "../../adapters/memory/clock.js";
import { createEventBus, type ObservabilityEvent } from "../../kernel/events.js";
import type { FetchLike } from "../../ports/http.js";
import { createWorkspace } from "../workspace/workspace.js";
import { createFetchTools, isForbiddenHost, matchesAllowlist, type FetchToolConfig, type FetchToolDeps } from "./fetch-tool.js";

const ctx = {
  toolCallId: "call_1",
  requestId: "req_1",
  messages: [],
  signal: new AbortController().signal,
};

function neverTimeout() {
  return { promise: new Promise<void>(() => {}), cancel: () => {} };
}

function instantTimeout() {
  return { promise: Promise.resolve(), cancel: () => {} };
}

function makeDeps(routes: Record<string, MemoryHttpResponse | MemoryHttpResponse[] | ((url: string, init?: Parameters<FetchLike>[1]) => MemoryHttpResponse)>, extra?: Partial<FetchToolDeps>) {
  const events: ObservabilityEvent[] = [];
  const bus = createEventBus({ agent: "test", name: "a1" });
  bus.subscribe("*", (e) => events.push(e));
  const clock = createTestClock(1000);
  const deps: FetchToolDeps = {
    fetch: createMemoryFetch(routes),
    clock,
    bus,
    timeout: neverTimeout,
    ...extra,
  };
  return { deps, events, clock };
}

async function run(tools: ReturnType<typeof createFetchTools>, name: string, input: unknown) {
  const t = tools[name];
  if (!t?.execute) throw new Error(`no executable tool named ${name}`);
  return t.execute(input, ctx);
}

describe("matchesAllowlist", () => {
  it("bare origin matches the origin and every subpath", () => {
    expect(matchesAllowlist("https://example.com/a/b", ["https://example.com"])).toBe(true);
    expect(matchesAllowlist("https://example.com/", ["https://example.com"])).toBe(true);
  });

  it("explicit literal path matches only that exact path, not subpaths", () => {
    expect(matchesAllowlist("https://x.com/v1", ["https://x.com/v1"])).toBe(true);
    expect(matchesAllowlist("https://x.com/v1/a", ["https://x.com/v1"])).toBe(false);
  });

  it("* matches within one path segment only", () => {
    expect(matchesAllowlist("https://x.com/v1/a", ["https://x.com/v1/*"])).toBe(true);
    expect(matchesAllowlist("https://x.com/v1/a/b", ["https://x.com/v1/*"])).toBe(false);
  });

  it("** matches across path segments", () => {
    expect(matchesAllowlist("https://x.com/v1/a/b", ["https://x.com/v1/**"])).toBe(true);
  });

  it("ignores query and fragment when matching", () => {
    expect(matchesAllowlist("https://x.com/v1?a=1#frag", ["https://x.com/v1"])).toBe(true);
  });

  it("rejects a different host or scheme", () => {
    expect(matchesAllowlist("https://evil.com/v1", ["https://x.com/v1"])).toBe(false);
    expect(matchesAllowlist("http://x.com/v1", ["https://x.com/v1"])).toBe(false);
  });

  it("matches path-only patterns against a path-only or absolute url", () => {
    expect(matchesAllowlist("/v1/docs/get", ["/v1/docs/**"])).toBe(true);
    expect(matchesAllowlist("https://svc.internal/v1/docs/get", ["/v1/docs/**"])).toBe(true);
    expect(matchesAllowlist("/v1/other", ["/v1/docs/**"])).toBe(false);
  });
});

describe("isForbiddenHost", () => {
  const forbidden = [
    "http://localhost/",
    "http://127.0.0.1/",
    "http://127.5.5.5/",
    "http://10.0.0.5/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://169.254.1.1/",
    "http://0.0.0.0/",
    "http://foo.internal/",
    "http://[::1]/",
    "http://[fc00::1]/",
    "http://[fe80::1]/",
  ];
  for (const url of forbidden) {
    it(`blocks ${url}`, () => {
      expect(isForbiddenHost(url)).toBe(true);
    });
  }

  it("allows a normal public host", () => {
    expect(isForbiddenHost("https://example.com/")).toBe(false);
  });

  it("allows an address just outside the 172.16.0.0/12 range", () => {
    expect(isForbiddenHost("http://172.32.0.1/")).toBe(false);
  });

  it("returns false for path-only (non-absolute) input", () => {
    expect(isForbiddenHost("/v1/docs")).toBe(false);
  });
});

describe("createFetchTools", () => {
  it("exposes fetch_url when allowlist is configured", () => {
    const { deps } = makeDeps({});
    const tools = createFetchTools({ allowlist: ["https://example.com"] }, deps);
    expect(tools.fetch_url).toBeDefined();
  });

  it("exposes one fetch_<name> tool per binding", () => {
    const { deps } = makeDeps({});
    const config: FetchToolConfig = {
      bindings: { docs: { fetch: deps.fetch, allowlist: ["/v1/**"] } },
    };
    const tools = createFetchTools(config, deps);
    expect(tools.fetch_docs).toBeDefined();
    expect(tools.fetch_url).toBeUndefined();
  });

  describe("fetch_url basic requests", () => {
    it("returns a successful text result", async () => {
      const { deps } = makeDeps({
        "https://example.com/a": { status: 200, headers: { "content-type": "text/plain" }, body: "hello" },
      });
      const tools = createFetchTools({ allowlist: ["https://example.com"] }, deps);
      const out = await run(tools, "fetch_url", { url: "https://example.com/a" });
      expect(out).toMatchObject({ ok: true, status: 200, body: "hello", truncated: false });
    });

    it("blocks a url outside the allowlist with disallowed_url", async () => {
      const { deps } = makeDeps({
        "https://evil.com/a": { status: 200, body: "x" },
      });
      const tools = createFetchTools({ allowlist: ["https://example.com"] }, deps);
      const out = await run(tools, "fetch_url", { url: "https://evil.com/a" });
      expect(out).toEqual({ ok: false, code: "disallowed_url", message: expect.any(String) });
    });

    it("blocks a forbidden host even when it is allowlisted", async () => {
      const { deps } = makeDeps({
        "http://localhost/a": { status: 200, body: "x" },
      });
      const tools = createFetchTools({ allowlist: ["http://localhost"] }, deps);
      const out = await run(tools, "fetch_url", { url: "http://localhost/a" });
      expect(out).toEqual({ ok: false, code: "disallowed_url", message: expect.any(String) });
    });

    it("returns non_2xx with status for an error response", async () => {
      const { deps } = makeDeps({
        "https://example.com/a": { status: 500, body: "boom" },
      });
      const tools = createFetchTools({ allowlist: ["https://example.com"] }, deps);
      const out = await run(tools, "fetch_url", { url: "https://example.com/a" });
      expect(out).toEqual({ ok: false, code: "non_2xx", message: expect.any(String), status: 500 });
    });

    it("maps a rejected fetch to request_failed", async () => {
      const { deps } = makeDeps({});
      const tools = createFetchTools({ allowlist: ["https://example.com"] }, deps);
      const out = await run(tools, "fetch_url", { url: "https://example.com/missing" });
      expect(out).toMatchObject({ ok: false, code: "request_failed" });
    });
  });

  describe("redirects", () => {
    it("follows an allowed redirect hop", async () => {
      const { deps } = makeDeps({
        "https://example.com/from": { status: 302, headers: { location: "https://example.com/to" } },
        "https://example.com/to": { status: 200, headers: { "content-type": "text/plain" }, body: "landed" },
      });
      const tools = createFetchTools({ allowlist: ["https://example.com"] }, deps);
      const out = await run(tools, "fetch_url", { url: "https://example.com/from" });
      expect(out).toMatchObject({ ok: true, status: 200, body: "landed", finalUrl: "https://example.com/to" });
    });

    it("refuses a redirect to a disallowed target", async () => {
      const { deps } = makeDeps({
        "https://example.com/from": { status: 302, headers: { location: "https://evil.com/to" } },
      });
      const tools = createFetchTools({ allowlist: ["https://example.com"] }, deps);
      const out = await run(tools, "fetch_url", { url: "https://example.com/from" });
      expect(out).toEqual({ ok: false, code: "disallowed_redirect", message: expect.any(String) });
    });

    it("fails after more than 5 redirect hops", async () => {
      const routes: Record<string, MemoryHttpResponse> = {};
      for (let i = 0; i < 7; i++) {
        routes[`https://example.com/${i}`] = {
          status: 302,
          headers: { location: `https://example.com/${i + 1}` },
        };
      }
      routes["https://example.com/7"] = { status: 200, body: "ok" };
      const { deps } = makeDeps(routes);
      const tools = createFetchTools({ allowlist: ["https://example.com"] }, deps);
      const out = await run(tools, "fetch_url", { url: "https://example.com/0" });
      expect(out).toEqual({ ok: false, code: "disallowed_redirect", message: expect.any(String) });
    });

    it("does not follow redirects when followRedirects is false", async () => {
      const { deps } = makeDeps({
        "https://example.com/from": { status: 302, headers: { location: "https://example.com/to" } },
      });
      const tools = createFetchTools({ allowlist: ["https://example.com"], followRedirects: false }, deps);
      const out = await run(tools, "fetch_url", { url: "https://example.com/from" });
      expect(out).toMatchObject({ ok: false, code: "non_2xx", status: 302 });
    });

    it("refuses a cross-origin redirect for a binding tool", async () => {
      const { deps } = makeDeps({
        "/v1/from": { status: 302, headers: { location: "https://evil.com/steal" } },
      });
      const config: FetchToolConfig = {
        bindings: { docs: { fetch: deps.fetch, allowlist: ["/v1/**"], headers: { "x-api-key": "secret" } } },
      };
      const tools = createFetchTools(config, deps);
      const out = await run(tools, "fetch_docs", { url: "/v1/from" });
      expect(out).toEqual({ ok: false, code: "disallowed_redirect", message: expect.any(String) });
    });

    it("follows a same-origin (local path) redirect for a binding tool, resending fixed headers", async () => {
      let secondHopHeaders: Record<string, string> | undefined;
      const deps = makeDeps({
        "/v1/from": { status: 302, headers: { location: "/v1/to" } },
        "/v1/to": (_url, init) => {
          secondHopHeaders = init?.headers;
          return { status: 200, headers: { "content-type": "text/plain" }, body: "landed" };
        },
      }).deps;
      const config: FetchToolConfig = {
        bindings: { docs: { fetch: deps.fetch, allowlist: ["/v1/**"], headers: { "x-api-key": "secret" } } },
      };
      const tools = createFetchTools(config, deps);
      const out = await run(tools, "fetch_docs", { url: "/v1/from" });
      expect(out).toMatchObject({ ok: true, body: "landed" });
      expect(secondHopHeaders?.["x-api-key"]).toBe("secret");
    });
  });

  describe("header policy", () => {
    it("drops model headers not in the allowlist", async () => {
      let seen: Record<string, string> | undefined;
      const { deps } = makeDeps({
        "https://example.com/a": (_url, init) => {
          seen = init?.headers;
          return { status: 200, body: "ok" };
        },
      });
      const tools = createFetchTools({ allowlist: ["https://example.com"] }, deps);
      await run(tools, "fetch_url", { url: "https://example.com/a", headers: { "x-custom": "y", range: "bytes=0-10" } });
      expect(seen?.["x-custom"]).toBeUndefined();
      expect(seen?.range).toBe("bytes=0-10");
    });

    it("applies binding fixed headers to every request", async () => {
      let seen: Record<string, string> | undefined;
      const { deps } = makeDeps({
        "/v1/a": (_url, init) => {
          seen = init?.headers;
          return { status: 200, body: "ok" };
        },
      });
      const config: FetchToolConfig = {
        bindings: { docs: { fetch: deps.fetch, allowlist: ["/v1/**"], headers: { "x-api-key": "secret" } } },
      };
      const tools = createFetchTools(config, deps);
      await run(tools, "fetch_docs", { url: "/v1/a" });
      expect(seen?.["x-api-key"]).toBe("secret");
    });
  });

  describe("size and body handling", () => {
    it("fails with too_large when body exceeds maxBytes and no workspace is configured", async () => {
      const { deps } = makeDeps({
        "https://example.com/big": { status: 200, headers: { "content-type": "text/plain" }, body: "x".repeat(100) },
      });
      const tools = createFetchTools({ allowlist: ["https://example.com"], maxBytes: 10 }, deps);
      const out = await run(tools, "fetch_url", { url: "https://example.com/big" });
      expect(out).toEqual({ ok: false, code: "too_large", message: expect.any(String), status: 200 });
    });

    it("spills an oversized body to the workspace when workspace mode is available", async () => {
      const store = createMemoryKeyValueStore();
      const clock = createTestClock(2000);
      const workspace = createWorkspace({ store, clock });
      const { deps } = makeDeps(
        { "https://example.com/big": { status: 200, headers: { "content-type": "text/plain" }, body: "x".repeat(100) } },
        { workspace, clock }
      );
      const tools = createFetchTools({ allowlist: ["https://example.com"], maxBytes: 10 }, deps);
      const out = await run(tools, "fetch_url", { url: "https://example.com/big" });
      expect(out).toMatchObject({ ok: true, path: expect.stringMatching(/^fetch\/example\.com\//) });
      const path = (out as { path: string }).path;
      expect(workspace.exists(path)).toBe(true);
    });

    it("truncates text bodies at maxModelChars and sets truncated: true", async () => {
      const { deps } = makeDeps({
        "https://example.com/a": { status: 200, headers: { "content-type": "text/plain" }, body: "x".repeat(100) },
      });
      const tools = createFetchTools({ allowlist: ["https://example.com"], maxModelChars: 10 }, deps);
      const out = await run(tools, "fetch_url", { url: "https://example.com/a" });
      expect(out).toMatchObject({ ok: true, truncated: true });
      expect((out as { body: string }).body.length).toBeGreaterThan(10);
    });

    it("parses application/json content-type into json, bounded by maxBytes", async () => {
      const { deps } = makeDeps({
        "https://example.com/a": {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ a: 1 }),
        },
      });
      const tools = createFetchTools({ allowlist: ["https://example.com"] }, deps);
      const out = await run(tools, "fetch_url", { url: "https://example.com/a" });
      expect(out).toMatchObject({ ok: true, json: { a: 1 } });
    });

    it("returns invalid_json when the body is not valid JSON", async () => {
      const { deps } = makeDeps({
        "https://example.com/a": { status: 200, headers: { "content-type": "application/json" }, body: "{not json" },
      });
      const tools = createFetchTools({ allowlist: ["https://example.com"] }, deps);
      const out = await run(tools, "fetch_url", { url: "https://example.com/a" });
      expect(out).toEqual({ ok: false, code: "invalid_json", message: expect.any(String), status: 200 });
    });

    it("returns unsupported_content_type for binary content with no workspace configured", async () => {
      const { deps } = makeDeps({
        "https://example.com/a": { status: 200, headers: { "content-type": "application/octet-stream" }, body: "\x00\x01" },
      });
      const tools = createFetchTools({ allowlist: ["https://example.com"] }, deps);
      const out = await run(tools, "fetch_url", { url: "https://example.com/a" });
      expect(out).toEqual({ ok: false, code: "unsupported_content_type", message: expect.any(String), status: 200 });
    });
  });

  describe("timeout", () => {
    it("returns the timeout code when the timeout wins the race", async () => {
      const { deps } = makeDeps(
        { "https://example.com/slow": { status: 200, body: "late" } },
        { timeout: instantTimeout }
      );
      const tools = createFetchTools({ allowlist: ["https://example.com"], timeoutMs: 5 }, deps);
      const out = await run(tools, "fetch_url", { url: "https://example.com/slow" });
      expect(out).toEqual({ ok: false, code: "timeout", message: expect.any(String) });
    });
  });

  describe("events", () => {
    it("emits tool:fetch for a successful call", async () => {
      const { deps, events } = makeDeps({
        "https://example.com/a": { status: 200, headers: { "content-type": "text/plain" }, body: "hi" },
      });
      const tools = createFetchTools({ allowlist: ["https://example.com"] }, deps);
      await run(tools, "fetch_url", { url: "https://example.com/a" });
      const fetchEvents = events.filter((e) => e.type === "tool:fetch");
      expect(fetchEvents).toHaveLength(1);
      expect(fetchEvents[0]?.payload).toMatchObject({ url: "https://example.com/a", ok: true, status: 200 });
    });

    it("emits tool:fetch for a blocked call", async () => {
      const { deps, events } = makeDeps({});
      const tools = createFetchTools({ allowlist: ["https://example.com"] }, deps);
      await run(tools, "fetch_url", { url: "https://evil.com/a" });
      const fetchEvents = events.filter((e) => e.type === "tool:fetch");
      expect(fetchEvents).toHaveLength(1);
      expect(fetchEvents[0]?.payload).toMatchObject({ url: "https://evil.com/a", ok: false, code: "disallowed_url" });
    });
  });
});
