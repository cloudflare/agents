import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { createApp } from "../app";
import type { CreateAppOptions } from "../app";

let testId = 0;

/**
 * Build an app with createApp, load it into the Worker Loader,
 * call fetch(), and return the Response.
 */
async function buildAppAndFetch(
  options: CreateAppOptions,
  request: Request = new Request("http://app/")
): Promise<Response> {
  const result = await createApp(options);
  const id = "test-app-" + testId++;
  const worker = env.LOADER.get(id, () => ({
    mainModule: result.mainModule,
    modules: result.modules,
    compatibilityDate: result.wranglerConfig?.compatibilityDate ?? "2026-01-01",
    compatibilityFlags: result.wranglerConfig?.compatibilityFlags
  }));
  return worker.getEntrypoint().fetch(request);
}

// ── Basic asset serving ─────────────────────────────────────────────

describe("createApp e2e — static assets", () => {
  it("serves a static HTML asset at /", async () => {
    const res = await buildAppAndFetch({
      files: {
        "src/index.ts": [
          "export default {",
          "  fetch() { return new Response('api'); }",
          "};"
        ].join("\n")
      },
      assets: {
        "/index.html": "<!DOCTYPE html><h1>Hello</h1>"
      }
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<!DOCTYPE html><h1>Hello</h1>");
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  it("serves a JS asset with correct content type", async () => {
    const res = await buildAppAndFetch(
      {
        files: {
          "src/index.ts": [
            "export default {",
            "  fetch() { return new Response('api'); }",
            "};"
          ].join("\n")
        },
        assets: {
          "/index.html": "<h1>Home</h1>",
          "/app.js": "console.log('hello')"
        }
      },
      new Request("http://app/app.js")
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log('hello')");
    expect(res.headers.get("Content-Type")).toBe(
      "application/javascript; charset=utf-8"
    );
  });

  it("serves CSS with correct content type", async () => {
    const res = await buildAppAndFetch(
      {
        files: {
          "src/index.ts": [
            "export default {",
            "  fetch() { return new Response('api'); }",
            "};"
          ].join("\n")
        },
        assets: {
          "/styles.css": "body { color: red; }"
        }
      },
      new Request("http://app/styles.css")
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("body { color: red; }");
    expect(res.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
  });
});

// ── Fall-through to server ──────────────────────────────────────────

describe("createApp e2e — server fall-through", () => {
  it("falls through to user Worker for non-asset routes", async () => {
    const res = await buildAppAndFetch(
      {
        files: {
          "src/index.ts": [
            "export default {",
            "  fetch() { return Response.json({ status: 'ok' }); }",
            "};"
          ].join("\n")
        },
        assets: {
          "/index.html": "<h1>Home</h1>"
        }
      },
      new Request("http://app/api/data")
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ status: "ok" });
  });

  it("falls through for POST requests even to asset paths", async () => {
    const res = await buildAppAndFetch(
      {
        files: {
          "src/index.ts": [
            "export default {",
            "  fetch(req) {",
            '    return new Response("posted: " + req.method);',
            "  }",
            "};"
          ].join("\n")
        },
        assets: {
          "/index.html": "<h1>Home</h1>"
        }
      },
      new Request("http://app/index.html", { method: "POST" })
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("posted: POST");
  });

  it("server can read request URL and headers", async () => {
    const res = await buildAppAndFetch(
      {
        files: {
          "src/index.ts": [
            "export default {",
            "  fetch(req) {",
            "    const url = new URL(req.url);",
            "    return Response.json({",
            "      path: url.pathname,",
            '      auth: req.headers.get("Authorization")',
            "    });",
            "  }",
            "};"
          ].join("\n")
        },
        assets: {}
      },
      new Request("http://app/api/users", {
        headers: { Authorization: "Bearer token123" }
      })
    );

    const data = (await res.json()) as { path: string; auth: string };
    expect(data.path).toBe("/api/users");
    expect(data.auth).toBe("Bearer token123");
  });
});

// ── ETag / conditional requests ─────────────────────────────────────

describe("createApp e2e — ETag and caching", () => {
  it("includes ETag in asset responses", async () => {
    const res = await buildAppAndFetch(
      {
        files: {
          "src/index.ts":
            "export default { fetch() { return new Response('api'); } };"
        },
        assets: {
          "/app.js": "console.log('hello')"
        }
      },
      new Request("http://app/app.js")
    );

    expect(res.status).toBe(200);
    const etag = res.headers.get("ETag");
    expect(etag).toBeTruthy();
    expect(etag!.startsWith('"')).toBe(true);
  });

  it("returns 304 for matching If-None-Match", async () => {
    const options: CreateAppOptions = {
      files: {
        "src/index.ts":
          "export default { fetch() { return new Response('api'); } };"
      },
      assets: {
        "/app.js": "console.log('hello')"
      }
    };

    // First request to get ETag
    const result = await createApp(options);
    const id = "test-app-etag-" + testId++;
    const worker = env.LOADER.get(id, () => ({
      mainModule: result.mainModule,
      modules: result.modules,
      compatibilityDate: "2026-01-01"
    }));

    const first = await worker
      .getEntrypoint()
      .fetch(new Request("http://app/app.js"));
    const etag = first.headers.get("ETag")!;

    // Second request with If-None-Match
    const second = await worker.getEntrypoint().fetch(
      new Request("http://app/app.js", {
        headers: { "If-None-Match": etag }
      })
    );

    expect(second.status).toBe(304);
  });

  it("sets Cache-Control must-revalidate for HTML", async () => {
    const res = await buildAppAndFetch(
      {
        files: {
          "src/index.ts":
            "export default { fetch() { return new Response('api'); } };"
        },
        assets: {
          "/index.html": "<h1>Home</h1>"
        }
      },
      new Request("http://app/")
    );

    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=0, must-revalidate"
    );
  });

  it("sets Cache-Control immutable for hashed assets", async () => {
    const res = await buildAppAndFetch(
      {
        files: {
          "src/index.ts":
            "export default { fetch() { return new Response('api'); } };"
        },
        assets: {
          "/app.a1b2c3d4e5f6.js": "console.log('versioned')"
        }
      },
      new Request("http://app/app.a1b2c3d4e5f6.js")
    );

    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable"
    );
  });
});

// ── HTML handling ───────────────────────────────────────────────────

describe("createApp e2e — HTML handling", () => {
  it("serves /about via /about.html (auto-trailing-slash)", async () => {
    const res = await buildAppAndFetch(
      {
        files: {
          "src/index.ts":
            "export default { fetch() { return new Response('api'); } };"
        },
        assets: {
          "/about.html": "<h1>About</h1>"
        }
      },
      new Request("http://app/about")
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>About</h1>");
  });

  it("serves /blog/ via /blog/index.html", async () => {
    const res = await buildAppAndFetch(
      {
        files: {
          "src/index.ts":
            "export default { fetch() { return new Response('api'); } };"
        },
        assets: {
          "/blog/index.html": "<h1>Blog</h1>"
        }
      },
      new Request("http://app/blog/")
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>Blog</h1>");
  });
});

// ── SPA fallback ────────────────────────────────────────────────────

describe("createApp e2e — SPA fallback", () => {
  it("serves /index.html for unknown routes with SPA config", async () => {
    const res = await buildAppAndFetch(
      {
        files: {
          "src/index.ts":
            "export default { fetch() { return new Response('api'); } };"
        },
        assets: {
          "/index.html": "<!DOCTYPE html><div id='root'></div>"
        },
        assetConfig: {
          not_found_handling: "single-page-application"
        }
      },
      new Request("http://app/dashboard/settings", {
        headers: { Accept: "text/html,application/xhtml+xml" }
      })
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<!DOCTYPE html><div id='root'></div>");
  });

  it("falls through to server for non-HTML requests (API calls)", async () => {
    const res = await buildAppAndFetch(
      {
        files: {
          "src/index.ts":
            "export default { fetch() { return new Response('api'); } };"
        },
        assets: {
          "/index.html": "<!DOCTYPE html><div id='root'></div>"
        },
        assetConfig: {
          not_found_handling: "single-page-application"
        }
      },
      new Request("http://app/api/counter")
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("api");
  });

  it("still serves exact assets over SPA fallback", async () => {
    const res = await buildAppAndFetch(
      {
        files: {
          "src/index.ts":
            "export default { fetch() { return new Response('api'); } };"
        },
        assets: {
          "/index.html": "<h1>Home</h1>",
          "/app.js": "console.log('app')"
        },
        assetConfig: {
          not_found_handling: "single-page-application"
        }
      },
      new Request("http://app/app.js")
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log('app')");
  });
});

// ── Client bundling ─────────────────────────────────────────────────

describe("createApp e2e — client bundling", () => {
  it("bundles a client entry and serves it as an asset", async () => {
    const res = await buildAppAndFetch(
      {
        files: {
          "src/index.ts": [
            "export default {",
            "  fetch() { return new Response('server'); }",
            "};"
          ].join("\n"),
          "src/client.ts": [
            'const msg: string = "hello from client";',
            "console.log(msg);"
          ].join("\n")
        },
        client: "src/client.ts",
        assets: {
          "/index.html": '<script src="/client.js"></script>'
        }
      },
      new Request("http://app/client.js")
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    // The bundled output should contain the string from the source
    expect(text).toContain("hello from client");
    expect(res.headers.get("Content-Type")).toBe(
      "application/javascript; charset=utf-8"
    );
  });

  it("serves the HTML page that references the client bundle", async () => {
    const res = await buildAppAndFetch(
      {
        files: {
          "src/index.ts": [
            "export default {",
            "  fetch() { return new Response('server'); }",
            "};"
          ].join("\n"),
          "src/client.ts": 'console.log("app");'
        },
        client: "src/client.ts",
        assets: {
          "/index.html": '<!DOCTYPE html><script src="/client.js"></script>'
        }
      },
      new Request("http://app/")
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(
      '<!DOCTYPE html><script src="/client.js"></script>'
    );
  });
});

// ── Multiple assets ─────────────────────────────────────────────────

describe("createApp e2e — multiple assets", () => {
  it("serves multiple different asset types", async () => {
    const options: CreateAppOptions = {
      files: {
        "src/index.ts":
          "export default { fetch() { return new Response('api'); } };"
      },
      assets: {
        "/index.html": "<h1>Home</h1>",
        "/app.js": "console.log('app')",
        "/styles.css": "body { margin: 0; }",
        "/data.json": '{"key":"value"}',
        "/robots.txt": "User-agent: *"
      }
    };

    const result = await createApp(options);
    const id = "test-app-multi-" + testId++;
    const worker = env.LOADER.get(id, () => ({
      mainModule: result.mainModule,
      modules: result.modules,
      compatibilityDate: "2026-01-01"
    }));
    const ep = worker.getEntrypoint();

    const html = await ep.fetch(new Request("http://app/"));
    expect(html.status).toBe(200);
    expect(html.headers.get("Content-Type")).toBe("text/html; charset=utf-8");

    const js = await ep.fetch(new Request("http://app/app.js"));
    expect(js.status).toBe(200);
    expect(await js.text()).toBe("console.log('app')");

    const css = await ep.fetch(new Request("http://app/styles.css"));
    expect(css.status).toBe(200);
    expect(await css.text()).toBe("body { margin: 0; }");

    const json = await ep.fetch(new Request("http://app/data.json"));
    expect(json.status).toBe(200);
    expect(await json.text()).toBe('{"key":"value"}');

    const txt = await ep.fetch(new Request("http://app/robots.txt"));
    expect(txt.status).toBe(200);
    expect(await txt.text()).toBe("User-agent: *");

    // API route falls through
    const api = await ep.fetch(new Request("http://app/api/data"));
    expect(api.status).toBe(200);
    expect(await api.text()).toBe("api");
  });
});

// ── Error cases ─────────────────────────────────────────────────────

describe("createApp error cases", () => {
  it("throws when server entry is not found", async () => {
    await expect(
      createApp({
        files: { "src/other.ts": "export const x = 1;" },
        server: "src/index.ts"
      })
    ).rejects.toThrow('Server entry point "src/index.ts" not found');
  });

  it("throws when client entry is not found", async () => {
    await expect(
      createApp({
        files: {
          "src/index.ts":
            "export default { fetch() { return new Response('ok'); } };"
        },
        client: "src/client.ts"
      })
    ).rejects.toThrow('Client entry point "src/client.ts" not found');
  });
});

// ── Output structure ────────────────────────────────────────────────

describe("createApp output structure", () => {
  it("returns __app-wrapper.js as mainModule", async () => {
    const result = await createApp({
      files: {
        "src/index.ts":
          "export default { fetch() { return new Response('ok'); } };"
      },
      assets: { "/index.html": "<h1>Hi</h1>" }
    });

    expect(result.mainModule).toBe("__app-wrapper.js");
  });

  it("includes asset manifest in modules", async () => {
    const result = await createApp({
      files: {
        "src/index.ts":
          "export default { fetch() { return new Response('ok'); } };"
      },
      assets: {
        "/index.html": "<h1>Hi</h1>",
        "/app.js": "console.log('hi')"
      }
    });

    expect(result.modules["__asset-manifest.json"]).toBeDefined();
  });

  it("includes asset modules with __assets/ prefix", async () => {
    const result = await createApp({
      files: {
        "src/index.ts":
          "export default { fetch() { return new Response('ok'); } };"
      },
      assets: {
        "/index.html": "<h1>Hi</h1>",
        "/app.js": "console.log('hi')"
      }
    });

    expect(result.modules["__assets/index.html"]).toBeDefined();
    expect(result.modules["__assets/app.js"]).toBeDefined();
  });

  it("populates assetMap", async () => {
    const result = await createApp({
      files: {
        "src/index.ts":
          "export default { fetch() { return new Response('ok'); } };"
      },
      assets: {
        "/index.html": "<h1>Hi</h1>"
      }
    });

    expect(result.assetManifest.size).toBe(1);
    expect(result.assetManifest.get("/index.html")).toBeDefined();
  });

  it("reports clientBundles when client entry is provided", async () => {
    const result = await createApp({
      files: {
        "src/index.ts":
          "export default { fetch() { return new Response('ok'); } };",
        "src/client.ts": "console.log('hi')"
      },
      client: "src/client.ts",
      assets: {}
    });

    expect(result.clientBundles).toBeDefined();
    expect(result.clientBundles).toContain("/client.js");
  });
});

// ── 404-page handling ────────────────────────────────────────────────

describe("createApp e2e — 404-page not-found handling", () => {
  it("serves 404.html with status 404", async () => {
    const res = await buildAppAndFetch(
      {
        files: {
          "src/index.ts":
            "export default { fetch() { return new Response('api'); } };"
        },
        assets: {
          "/index.html": "<h1>Home</h1>",
          "/404.html": "<h1>Not Found</h1>"
        },
        assetConfig: {
          not_found_handling: "404-page"
        }
      },
      new Request("http://app/nonexistent", {
        headers: { Accept: "text/html" }
      })
    );

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("<h1>Not Found</h1>");
  });

  it("serves nested 404.html walking up directories", async () => {
    const res = await buildAppAndFetch(
      {
        files: {
          "src/index.ts":
            "export default { fetch() { return new Response('api'); } };"
        },
        assets: {
          "/index.html": "<h1>Home</h1>",
          "/blog/404.html": "<h1>Blog Not Found</h1>"
        },
        assetConfig: {
          not_found_handling: "404-page"
        }
      },
      new Request("http://app/blog/missing-post", {
        headers: { Accept: "text/html" }
      })
    );

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("<h1>Blog Not Found</h1>");
  });

  it("falls through to server when no 404.html exists", async () => {
    const res = await buildAppAndFetch(
      {
        files: {
          "src/index.ts":
            "export default { fetch() { return new Response('api'); } };"
        },
        assets: {
          "/index.html": "<h1>Home</h1>"
        },
        assetConfig: {
          not_found_handling: "404-page"
        }
      },
      new Request("http://app/nonexistent")
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("api");
  });
});

// ── Wrapper code structure ──────────────────────────────────────────

describe("createApp — wrapper code structure", () => {
  it("module wrapper imports handleAssetRequest from runtime module", async () => {
    const result = await createApp({
      files: {
        "src/index.ts":
          "export default { fetch() { return new Response('ok'); } };"
      },
      assets: { "/index.html": "<h1>Hi</h1>" }
    });

    const wrapper = result.modules["__app-wrapper.js"] as string;
    expect(wrapper).toContain(
      'import { handleAssetRequest, createMemoryStorage } from "./__asset-runtime.js"'
    );
    expect(wrapper).toContain(
      "await handleAssetRequest(request, manifest, storage, ASSET_CONFIG)"
    );
  });

  it("DO wrapper imports handleAssetRequest from runtime module", async () => {
    const result = await createApp({
      files: {
        "src/index.ts":
          "export default { fetch() { return new Response('ok'); } };"
      },
      assets: { "/index.html": "<h1>Hi</h1>" },
      durableObject: true
    });

    const wrapper = result.modules["__app-wrapper.js"] as string;
    expect(wrapper).toContain(
      'import { handleAssetRequest, createMemoryStorage } from "./__asset-runtime.js"'
    );
    expect(wrapper).toContain(
      "await handleAssetRequest(request, manifest, storage, ASSET_CONFIG)"
    );
  });

  it("includes __asset-runtime.js in output modules", async () => {
    const result = await createApp({
      files: {
        "src/index.ts":
          "export default { fetch() { return new Response('ok'); } };"
      },
      assets: { "/index.html": "<h1>Hi</h1>" }
    });

    const runtime = result.modules["__asset-runtime.js"];
    expect(typeof runtime).toBe("string");
    expect(runtime as string).toContain("handleAssetRequest");
    expect(runtime as string).toContain("createMemoryStorage");
  });

  it("wrapper initializes manifest Map and storage at module level", async () => {
    const result = await createApp({
      files: {
        "src/index.ts":
          "export default { fetch() { return new Response('ok'); } };"
      },
      assets: { "/index.html": "<h1>Hi</h1>" }
    });

    const wrapper = result.modules["__app-wrapper.js"] as string;
    expect(wrapper).toContain("new Map(Object.entries(manifestJson))");
    expect(wrapper).toContain("createMemoryStorage(ASSET_CONTENT)");
  });

  it("module and DO wrappers share the same init block", async () => {
    const moduleResult = await createApp({
      files: {
        "src/index.ts":
          "export default { fetch() { return new Response('ok'); } };"
      },
      assets: { "/index.html": "<h1>Hi</h1>" }
    });

    const doResult = await createApp({
      files: {
        "src/index.ts":
          "export default { fetch() { return new Response('ok'); } };"
      },
      assets: { "/index.html": "<h1>Hi</h1>" },
      durableObject: true
    });

    const moduleWrapper = moduleResult.modules["__app-wrapper.js"] as string;
    const doWrapper = doResult.modules["__app-wrapper.js"] as string;

    // Extract the init block (ASSET_CONFIG through storage creation)
    const extractInit = (code: string) => {
      const start = code.indexOf("const ASSET_CONFIG");
      const end =
        code.indexOf("createMemoryStorage(ASSET_CONTENT)") +
        "createMemoryStorage(ASSET_CONTENT);".length;
      return code.slice(start, end).trim();
    };

    expect(extractInit(moduleWrapper)).toBe(extractInit(doWrapper));
  });
});

// ── Durable Object wrapper ──────────────────────────────────────────

describe("createApp — durableObject option", () => {
  it("sets durableObjectClassName to 'App' with durableObject: true", async () => {
    const result = await createApp({
      files: {
        "src/index.ts":
          "export default { fetch() { return new Response('ok'); } };"
      },
      assets: { "/index.html": "<h1>Hi</h1>" },
      durableObject: true
    });

    expect(result.durableObjectClassName).toBe("App");
  });

  it("uses custom className from durableObject option", async () => {
    const result = await createApp({
      files: {
        "src/index.ts":
          "export default { fetch() { return new Response('ok'); } };"
      },
      assets: { "/index.html": "<h1>Hi</h1>" },
      durableObject: { className: "MyApp" }
    });

    expect(result.durableObjectClassName).toBe("MyApp");
  });

  it("does not set durableObjectClassName without the option", async () => {
    const result = await createApp({
      files: {
        "src/index.ts":
          "export default { fetch() { return new Response('ok'); } };"
      },
      assets: { "/index.html": "<h1>Hi</h1>" }
    });

    expect(result.durableObjectClassName).toBeUndefined();
  });

  it("wrapper imports DurableObject from cloudflare:workers", async () => {
    const result = await createApp({
      files: {
        "src/index.ts":
          "export default { fetch() { return new Response('ok'); } };"
      },
      assets: { "/index.html": "<h1>Hi</h1>" },
      durableObject: true
    });

    const wrapper = result.modules["__app-wrapper.js"];
    expect(typeof wrapper).toBe("string");
    expect(wrapper as string).toContain(
      'import { DurableObject } from "cloudflare:workers"'
    );
  });

  it("wrapper exports named class with correct name", async () => {
    const result = await createApp({
      files: {
        "src/index.ts":
          "export default { fetch() { return new Response('ok'); } };"
      },
      assets: {},
      durableObject: { className: "Counter" }
    });

    const wrapper = result.modules["__app-wrapper.js"] as string;
    expect(wrapper).toContain("export class Counter extends BaseClass");
  });

  it("wrapper uses runtime handleAssetRequest and super.fetch fallback", async () => {
    const result = await createApp({
      files: {
        "src/index.ts":
          "export default { fetch() { return new Response('ok'); } };"
      },
      assets: { "/index.html": "<h1>Hi</h1>" },
      durableObject: true
    });

    const wrapper = result.modules["__app-wrapper.js"] as string;
    expect(wrapper).toContain(
      "handleAssetRequest(request, manifest, storage, ASSET_CONFIG)"
    );
    expect(wrapper).toContain("super.fetch(request)");
  });
});
