import { env } from "cloudflare:workers";
import { getServerByName } from "partyserver";
import { describe, expect, it } from "vitest";
import { createFetchTools } from "../tools/fetch";
import type {
  FetchResult,
  FetchWorkspace,
  CreateFetchToolsOptions
} from "../tools/fetch";
import type { ThinkFetchToolsTestAgent } from "./agents/fetch-tools";

// ── Helpers ───────────────────────────────────────────────────────

type Handler = (
  url: string,
  init: RequestInit | undefined
) => Response | Promise<Response>;

function makeBinding(handler: Handler): Fetcher {
  return {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      return Promise.resolve(handler(url, init));
    }
  } as unknown as Fetcher;
}

function makeWorkspace() {
  const files = new Map<string, string>();
  const bytes = new Map<string, Uint8Array>();
  const dirs: string[] = [];
  const ws: FetchWorkspace = {
    mkdir: (p) => {
      dirs.push(p);
    },
    writeFile: (p, c) => {
      files.set(p, c);
    },
    writeFileBytes: (p, b) => {
      bytes.set(p, b);
    }
  };
  return { files, bytes, dirs, ws };
}

const toolCtx = () => ({
  toolCallId: "test",
  messages: [],
  abortSignal: new AbortController().signal
});

async function runTool(
  tools: ReturnType<typeof createFetchTools>,
  name: string,
  input: Record<string, unknown>,
  ctx: ReturnType<typeof toolCtx> = toolCtx()
): Promise<FetchResult> {
  const t = tools[name];
  if (!t?.execute) throw new Error(`tool ${name} has no execute`);
  return (await t.execute(input, ctx)) as FetchResult;
}

function docsBinding(): Fetcher {
  return makeBinding((url) => {
    const { pathname } = new URL(url);
    switch (pathname) {
      case "/v1/docs/ok":
        return new Response("hello docs", {
          headers: { "content-type": "text/plain" }
        });
      case "/v1/docs/data.json":
        return new Response(JSON.stringify({ hello: "world" }), {
          headers: { "content-type": "application/json" }
        });
      case "/v1/docs/badjson":
        return new Response("not json", {
          headers: { "content-type": "application/json" }
        });
      case "/v1/docs/html":
        return new Response("<h1>hi</h1>", {
          headers: { "content-type": "text/html" }
        });
      case "/v1/docs/bin":
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { "content-type": "application/octet-stream" }
        });
      case "/v1/docs/big":
        return new Response("x".repeat(200), {
          headers: { "content-type": "text/plain" }
        });
      case "/v1/docs/redirect":
        return new Response(null, {
          status: 302,
          headers: { location: "/v1/docs/ok" }
        });
      case "/v1/docs/redirect-out":
        return new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/x" }
        });
      case "/v1/docs/echo":
        return new Response(null, {
          status: 500,
          headers: { "content-type": "text/plain" }
        });
      default:
        return new Response("nope", { status: 404 });
    }
  });
}

function docsTools(overrides: Partial<CreateFetchToolsOptions> = {}) {
  return createFetchTools({
    bindings: {
      docs: {
        binding: docsBinding(),
        allowlist: ["/v1/docs/**"],
        headers: { "x-agent": "think" }
      }
    },
    ...overrides
  });
}

// ── Config / registration ─────────────────────────────────────────

describe("createFetchTools — config", () => {
  it("throws when neither allowlist nor bindings are configured", () => {
    expect(() => createFetchTools({})).toThrow(/non-empty/);
    expect(() => createFetchTools({ allowlist: [] })).toThrow(/non-empty/);
  });

  it("registers fetch_url only when a public allowlist is set", () => {
    const tools = createFetchTools({
      allowlist: ["https://example.com/**"]
    });
    expect(Object.keys(tools)).toEqual(["fetch_url"]);
  });

  it("generates one fetch_<name> tool per binding with a sanitized name", () => {
    const tools = createFetchTools({
      bindings: {
        "docs-api": {
          binding: docsBinding(),
          allowlist: ["/**"]
        }
      }
    });
    expect(Object.keys(tools)).toEqual(["fetch_docs_api"]);
  });
});

// ── Public path: synchronous denials (no network) ─────────────────

describe("fetch_url — allowlist + SSRF", () => {
  const wildcard = createFetchTools({
    allowlist: ["https://**", "http://**"]
  });

  it("rejects URLs that are not on the allowlist", async () => {
    const tools = createFetchTools({
      allowlist: ["https://example.com/**"]
    });
    const res = await runTool(tools, "fetch_url", {
      url: "https://evil.com/x"
    });
    expect(res).toMatchObject({ ok: false, code: "disallowed_url" });
  });

  it("rejects invalid URLs", async () => {
    const res = await runTool(wildcard, "fetch_url", { url: "not a url" });
    expect(res).toMatchObject({ ok: false, code: "disallowed_url" });
  });

  it("rejects URLs with embedded credentials", async () => {
    const res = await runTool(wildcard, "fetch_url", {
      url: "https://user:pass@example.com/x"
    });
    expect(res).toMatchObject({ ok: false, code: "disallowed_url" });
  });

  it.each([
    "https://localhost/x",
    "https://app.localhost/x",
    "https://foo.internal/x",
    "http://127.0.0.1/x",
    "http://10.0.0.1/x",
    "http://192.168.1.1/x",
    "http://172.16.0.1/x",
    "http://169.254.169.254/x",
    "http://100.64.0.1/x", // CGNAT
    "http://0.0.0.0/x",
    "https://[::1]/x",
    "https://[fc00::1]/x", // ULA
    "https://[fe80::1]/x", // link-local
    "https://[::ffff:127.0.0.1]/x", // IPv4-mapped (serializes to ::ffff:7f00:1)
    "https://[::ffff:192.168.0.1]/x", // IPv4-mapped private
    "http://2130706433/", // decimal form of 127.0.0.1
    "http://0x7f.0.0.1/", // hex-dotted form of 127.0.0.1
    "http://0177.0.0.1/", // octal form of 127.0.0.1
    "http://127.1/" // shorthand form of 127.0.0.1
  ])("blocks private/local target %s even when allowlisted", async (url) => {
    const res = await runTool(wildcard, "fetch_url", { url });
    expect(res).toMatchObject({ ok: false, code: "disallowed_url" });
  });

  it("normalizes a bare-origin allowlist entry to match the origin and subpaths", async () => {
    const tools = createFetchTools({
      bindings: {
        api: {
          binding: makeBinding(
            () =>
              new Response("ok", { headers: { "content-type": "text/plain" } })
          ),
          allowlist: ["https://example.com"]
        }
      }
    });
    const sub = await runTool(tools, "fetch_api", {
      path: "https://example.com/docs/page"
    });
    expect(sub.ok).toBe(true);
    const root = await runTool(tools, "fetch_api", {
      path: "https://example.com"
    });
    expect(root.ok).toBe(true);
    const other = await runTool(tools, "fetch_api", {
      path: "https://evil.com/x"
    });
    expect(other).toMatchObject({ ok: false, code: "disallowed_url" });
  });
});

// ── Binding path: success + response modes ────────────────────────

describe("fetch_<binding> — responses", () => {
  it("returns text bodies", async () => {
    const res = await runTool(docsTools(), "fetch_docs", {
      path: "/v1/docs/ok"
    });
    expect(res).toMatchObject({
      ok: true,
      response: "text",
      body: "hello docs",
      truncated: false
    });
  });

  it("parses JSON bodies", async () => {
    const res = await runTool(docsTools(), "fetch_docs", {
      path: "/v1/docs/data.json"
    });
    expect(res).toMatchObject({ ok: true, response: "json" });
    if (res.ok) expect(res.json).toEqual({ hello: "world" });
  });

  it("reports invalid JSON", async () => {
    const res = await runTool(docsTools(), "fetch_docs", {
      path: "/v1/docs/badjson"
    });
    expect(res).toMatchObject({ ok: false, code: "invalid_json" });
  });

  it("returns HTML as text in auto mode", async () => {
    const res = await runTool(docsTools(), "fetch_docs", {
      path: "/v1/docs/html"
    });
    expect(res).toMatchObject({ ok: true, response: "text" });
    if (res.ok) expect(res.body).toContain("<h1>hi</h1>");
  });

  it("rejects binary content in auto mode without spill", async () => {
    const res = await runTool(docsTools(), "fetch_docs", {
      path: "/v1/docs/bin"
    });
    expect(res).toMatchObject({
      ok: false,
      code: "unsupported_content_type"
    });
  });

  it("surfaces non-2xx responses", async () => {
    const res = await runTool(docsTools(), "fetch_docs", {
      path: "/v1/docs/echo"
    });
    expect(res).toMatchObject({ ok: false, code: "non_2xx", status: 500 });
  });

  it("returns empty text for an empty (204) response", async () => {
    const tools = createFetchTools({
      bindings: {
        api: {
          binding: makeBinding(() => new Response(null, { status: 204 })),
          allowlist: ["/**"]
        }
      }
    });
    const res = await runTool(tools, "fetch_api", { path: "/x" });
    expect(res).toMatchObject({
      ok: true,
      response: "text",
      body: "",
      bytes: 0
    });
  });

  it("rejects paths outside the binding allowlist", async () => {
    const tools = createFetchTools({
      bindings: {
        docs: { binding: docsBinding(), allowlist: ["/v1/docs/**"] }
      }
    });
    const res = await runTool(tools, "fetch_docs", { path: "/secret" });
    expect(res).toMatchObject({ ok: false, code: "disallowed_url" });
  });
});

// ── Size limits ───────────────────────────────────────────────────

describe("fetch — size limits", () => {
  it("truncates oversized text and flags truncated", async () => {
    const res = await runTool(docsTools({ maxBytes: 10 }), "fetch_docs", {
      path: "/v1/docs/big"
    });
    expect(res).toMatchObject({ ok: true, response: "text", truncated: true });
    if (res.ok) expect(res.body?.startsWith("xxxxxxxxxx")).toBe(true);
  });

  it("returns too_large for JSON that exceeds the byte cap", async () => {
    const res = await runTool(docsTools({ maxBytes: 5 }), "fetch_docs", {
      path: "/v1/docs/data.json"
    });
    expect(res).toMatchObject({ ok: false, code: "too_large" });
  });
});

// ── Workspace spill ───────────────────────────────────────────────

describe("fetch — workspace spill", () => {
  it("writes text bodies to the workspace in workspace mode", async () => {
    const { ws, files } = makeWorkspace();
    const res = await runTool(docsTools({ workspace: ws }), "fetch_docs", {
      path: "/v1/docs/ok",
      response: "workspace"
    });
    expect(res).toMatchObject({ ok: true, response: "workspace" });
    if (res.ok && res.path) {
      expect(res.path.startsWith("/fetched/")).toBe(true);
      expect(files.get(res.path)).toBe("hello docs");
    }
  });

  it("writes binary bodies via writeFileBytes when spill is enabled in auto", async () => {
    const { ws, bytes } = makeWorkspace();
    const res = await runTool(
      docsTools({ workspace: ws, spillToWorkspace: true }),
      "fetch_docs",
      { path: "/v1/docs/bin" }
    );
    expect(res).toMatchObject({ ok: true, response: "workspace" });
    if (res.ok && res.path) {
      expect(Array.from(bytes.get(res.path) ?? [])).toEqual([1, 2, 3, 4]);
    }
  });
});

// ── Redirects ─────────────────────────────────────────────────────

describe("fetch — redirects", () => {
  it("follows same-origin redirects through the binding", async () => {
    const res = await runTool(docsTools(), "fetch_docs", {
      path: "/v1/docs/redirect"
    });
    expect(res).toMatchObject({ ok: true, body: "hello docs" });
    if (res.ok) expect(res.finalUrl).toContain("/v1/docs/ok");
  });

  it("blocks cross-origin redirects for bindings", async () => {
    const res = await runTool(docsTools(), "fetch_docs", {
      path: "/v1/docs/redirect-out"
    });
    expect(res).toMatchObject({ ok: false, code: "disallowed_redirect" });
  });

  it("does not follow redirects when policy is none", async () => {
    const res = await runTool(
      docsTools({ followRedirects: "none" }),
      "fetch_docs",
      { path: "/v1/docs/redirect" }
    );
    expect(res).toMatchObject({ ok: false, code: "disallowed_redirect" });
  });
});

// ── Header allowlist ──────────────────────────────────────────────

describe("fetch — header allowlist", () => {
  it("forwards allowlisted model headers and fixed headers, drops the rest", async () => {
    let seen: Headers | undefined;
    const tools = createFetchTools({
      bindings: {
        docs: {
          binding: makeBinding((_url, init) => {
            seen = new Headers(init?.headers);
            return new Response("ok", {
              headers: { "content-type": "text/plain" }
            });
          }),
          allowlist: ["/**"],
          headers: { "x-agent": "think" }
        }
      }
    });
    const res = await runTool(tools, "fetch_docs", {
      path: "/x",
      headers: { accept: "application/json", authorization: "secret" }
    });
    expect(res.ok).toBe(true);
    expect(seen?.get("accept")).toBe("application/json");
    expect(seen?.get("x-agent")).toBe("think");
    expect(seen?.get("authorization")).toBe(null);
  });

  it("sends a markdown-first default Accept header when none is set", async () => {
    let seen: Headers | undefined;
    const tools = createFetchTools({
      bindings: {
        docs: {
          binding: makeBinding((_url, init) => {
            seen = new Headers(init?.headers);
            return new Response("ok", {
              headers: { "content-type": "text/plain" }
            });
          }),
          allowlist: ["/**"]
        }
      }
    });
    await runTool(tools, "fetch_docs", { path: "/x" });
    expect(seen?.get("accept")).toContain("text/markdown");
  });

  it("lets the model override the default Accept header", async () => {
    let seen: Headers | undefined;
    const tools = createFetchTools({
      bindings: {
        docs: {
          binding: makeBinding((_url, init) => {
            seen = new Headers(init?.headers);
            return new Response("ok", {
              headers: { "content-type": "text/plain" }
            });
          }),
          allowlist: ["/**"]
        }
      }
    });
    await runTool(tools, "fetch_docs", {
      path: "/x",
      headers: { accept: "application/json" }
    });
    expect(seen?.get("accept")).toBe("application/json");
  });

  it("lets fixed binding headers take precedence over model headers", async () => {
    let seen: Headers | undefined;
    const tools = createFetchTools({
      bindings: {
        docs: {
          binding: makeBinding((_url, init) => {
            seen = new Headers(init?.headers);
            return new Response("ok", {
              headers: { "content-type": "text/plain" }
            });
          }),
          allowlist: ["/**"],
          headers: { accept: "application/vnd.fixed" }
        }
      }
    });
    await runTool(tools, "fetch_docs", {
      path: "/x",
      headers: { accept: "application/json" }
    });
    expect(seen?.get("accept")).toBe("application/vnd.fixed");
  });

  it("sends no default Accept header when disabled", async () => {
    let seen: Headers | undefined;
    const tools = createFetchTools({
      defaultAccept: "",
      bindings: {
        docs: {
          binding: makeBinding((_url, init) => {
            seen = new Headers(init?.headers);
            return new Response("ok", {
              headers: { "content-type": "text/plain" }
            });
          }),
          allowlist: ["/**"]
        }
      }
    });
    await runTool(tools, "fetch_docs", { path: "/x" });
    expect(seen?.get("accept")).toBe(null);
  });
});

// ── Abort + timeout ───────────────────────────────────────────────

describe("fetch — abort and timeout", () => {
  function hangTools(timeoutMs: number) {
    return createFetchTools({
      timeoutMs,
      bindings: {
        slow: {
          binding: makeBinding(
            (_url, init) =>
              new Promise<Response>((_resolve, reject) => {
                const signal = init?.signal;
                if (signal?.aborted) {
                  reject(new DOMException("Aborted", "AbortError"));
                  return;
                }
                signal?.addEventListener(
                  "abort",
                  () => reject(new DOMException("Aborted", "AbortError")),
                  { once: true }
                );
              })
          ),
          allowlist: ["/**"]
        }
      }
    });
  }

  it("times out a slow request", async () => {
    const res = await runTool(hangTools(5), "fetch_slow", { path: "/x" });
    expect(res).toMatchObject({ ok: false, code: "timeout" });
  });

  it("reports aborted when the turn signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const res = await runTool(
      hangTools(10_000),
      "fetch_slow",
      { path: "/x" },
      { toolCallId: "t", messages: [], abortSignal: controller.signal }
    );
    expect(res).toMatchObject({ ok: false, code: "aborted" });
  });
});

// ── Observability ─────────────────────────────────────────────────

describe("fetch — observability", () => {
  it("emits an event on success and on block", async () => {
    const events: Array<{ ok: boolean; code?: string; tool: string }> = [];
    const tools = createFetchTools({
      onEvent: (e) => events.push({ ok: e.ok, code: e.code, tool: e.tool }),
      bindings: {
        docs: { binding: docsBinding(), allowlist: ["/v1/docs/**"] }
      }
    });
    await runTool(tools, "fetch_docs", { path: "/v1/docs/ok" });
    await runTool(tools, "fetch_docs", { path: "/blocked" });
    expect(events).toEqual([
      { ok: true, code: undefined, tool: "fetch_docs" },
      { ok: false, code: "disallowed_url", tool: "fetch_docs" }
    ]);
  });
});

// ── Think integration (auto-merge + capability prompt) ────────────

describe("Think — fetchTools integration", () => {
  function agent(name: string) {
    return getServerByName(
      env.ThinkFetchToolsTestAgent as unknown as DurableObjectNamespace<ThinkFetchToolsTestAgent>,
      name
    ) as unknown as Promise<{
      enableFetch(): Promise<void>;
      captureTurn(): Promise<{ toolNames: string[]; system: string }>;
    }>;
  }

  it("does not register fetch tools by default", async () => {
    const a = await agent(`fetch-off-${crypto.randomUUID()}`);
    const { toolNames } = await a.captureTurn();
    expect(toolNames).not.toContain("fetch_url");
  });

  it("merges fetch_url and advertises it in the capability prompt when enabled", async () => {
    const a = await agent(`fetch-on-${crypto.randomUUID()}`);
    await a.enableFetch();
    const { toolNames, system } = await a.captureTurn();
    expect(toolNames).toContain("fetch_url");
    expect(system).toContain("fetch tools are available");
  });
});
