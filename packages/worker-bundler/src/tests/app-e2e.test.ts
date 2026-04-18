import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { createApp } from "../app";
import type { CreateAppOptions } from "../app";
import { handleAssetRequest, createMemoryStorage } from "../asset-handler";

let testId = 0;

/**
 * Build an app with createApp, serve assets on the host, and fall through
 * to the isolate for non-asset requests — mirroring how callers should use it.
 */
async function buildAppAndFetch(
  options: CreateAppOptions,
  request: Request = new Request("http://app/")
): Promise<Response> {
  const result = await createApp(options);

  const storage = createMemoryStorage(result.assets);
  const assetResponse = await handleAssetRequest(
    request,
    result.assetManifest,
    storage,
    result.assetConfig
  );
  if (assetResponse) return assetResponse;

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
    const result = await createApp({
      files: {
        "src/index.ts":
          "export default { fetch() { return new Response('api'); } };"
      },
      assets: {
        "/app.js": "console.log('hello')"
      }
    });

    const storage = createMemoryStorage(result.assets);

    const first = await handleAssetRequest(
      new Request("http://app/app.js"),
      result.assetManifest,
      storage
    );
    const etag = first!.headers.get("ETag")!;

    const second = await handleAssetRequest(
      new Request("http://app/app.js", {
        headers: { "If-None-Match": etag }
      }),
      result.assetManifest,
      storage
    );

    expect(second!.status).toBe(304);
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
    const storage = createMemoryStorage(result.assets);

    const id = "test-app-multi-" + testId++;
    const worker = env.LOADER.get(id, () => ({
      mainModule: result.mainModule,
      modules: result.modules,
      compatibilityDate: "2026-01-01"
    }));
    const ep = worker.getEntrypoint();

    async function fetch(request: Request): Promise<Response> {
      const assetResponse = await handleAssetRequest(
        request,
        result.assetManifest,
        storage,
        result.assetConfig
      );
      if (assetResponse) return assetResponse;
      return ep.fetch(request);
    }

    const html = await fetch(new Request("http://app/"));
    expect(html.status).toBe(200);
    expect(html.headers.get("Content-Type")).toBe("text/html; charset=utf-8");

    const js = await fetch(new Request("http://app/app.js"));
    expect(js.status).toBe(200);
    expect(await js.text()).toBe("console.log('app')");

    const css = await fetch(new Request("http://app/styles.css"));
    expect(css.status).toBe(200);
    expect(await css.text()).toBe("body { margin: 0; }");

    const json = await fetch(new Request("http://app/data.json"));
    expect(json.status).toBe(200);
    expect(await json.text()).toBe('{"key":"value"}');

    const txt = await fetch(new Request("http://app/robots.txt"));
    expect(txt.status).toBe(200);
    expect(await txt.text()).toBe("User-agent: *");

    const api = await fetch(new Request("http://app/api/data"));
    expect(api.status).toBe(200);
    expect(await api.text()).toBe("api");
  });
});

// ── Error cases ─────────────────────────────────────────────────────

describe("createApp error cases", () => {
  it("throws when server entry is not found and lists available files", async () => {
    await expect(
      createApp({
        files: { "src/other.ts": "export const x = 1;" },
        server: "src/index.ts"
      })
    ).rejects.toThrow(
      /Server entry point "src\/index.ts" was not found.*src\/other\.ts/
    );
  });

  it("throws when client entry is not found and lists available files", async () => {
    await expect(
      createApp({
        files: {
          "src/index.ts":
            "export default { fetch() { return new Response('ok'); } };"
        },
        client: "src/client.ts"
      })
    ).rejects.toThrow(
      /Client entry point "src\/client.ts" was not found.*src\/index\.ts/
    );
  });
});

// ── Output structure ────────────────────────────────────────────────

describe("createApp output structure", () => {
  it("returns server mainModule directly (no wrapper)", async () => {
    const result = await createApp({
      files: {
        "src/index.ts":
          "export default { fetch() { return new Response('ok'); } };"
      },
      assets: { "/index.html": "<h1>Hi</h1>" }
    });

    expect(result.mainModule).toBe("bundle.js");
  });

  it("does not embed assets in modules", async () => {
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

    expect(result.modules["__assets/index.html"]).toBeUndefined();
    expect(result.modules["__assets/app.js"]).toBeUndefined();
    expect(result.modules["__asset-manifest.json"]).toBeUndefined();
    expect(result.modules["__asset-runtime.js"]).toBeUndefined();
  });

  it("returns combined assets separately", async () => {
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

    expect(result.assets["/index.html"]).toBe("<h1>Hi</h1>");
    expect(result.assets["/app.js"]).toBe("console.log('hi')");
  });

  it("populates assetManifest", async () => {
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

  it("includes client bundles in assets", async () => {
    const result = await createApp({
      files: {
        "src/index.ts":
          "export default { fetch() { return new Response('ok'); } };",
        "src/client.ts": "console.log('hi')"
      },
      client: "src/client.ts",
      assets: {}
    });

    expect(result.assets["/client.js"]).toBeDefined();
    expect(typeof result.assets["/client.js"]).toBe("string");
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

// ── Advanced bundler options thread through to BOTH server and client ──

describe("createApp advanced bundler options", () => {
  it("applies `define` to the server bundle", async () => {
    const res = await buildAppAndFetch(
      {
        files: {
          "src/index.ts": [
            "declare const __APP_NAME__: string;",
            "export default {",
            "  fetch() { return new Response(__APP_NAME__); }",
            "};"
          ].join("\n")
        },
        define: {
          __APP_NAME__: '"server-saw-define"'
        }
      },
      new Request("http://app/api")
    );

    expect(await res.text()).toBe("server-saw-define");
  });

  it("applies `define` to client bundles too", async () => {
    // Build the app, then fetch the emitted client bundle and assert the
    // substitution happened. This catches a class of bug where someone
    // refactors the threading and forgets one of the two bundleWithEsbuild
    // call sites in createApp.
    const result = await createApp({
      files: {
        "src/server.ts":
          "export default { fetch() { return new Response('api'); } };",
        "src/client.ts": [
          "declare const __CLIENT_FLAG__: boolean;",
          "if (__CLIENT_FLAG__) {",
          '  document.body.textContent = "flag-on";',
          "}"
        ].join("\n")
      },
      server: "src/server.ts",
      client: "src/client.ts",
      define: {
        __CLIENT_FLAG__: "true"
      }
    });

    const clientBundle = result.assets["/client.js"];
    expect(typeof clientBundle).toBe("string");
    // After define + dead-code-elimination-friendly emission, the literal
    // `true` should appear and the placeholder identifier should NOT.
    expect(clientBundle as string).not.toContain("__CLIENT_FLAG__");
    expect(clientBundle as string).toContain("flag-on");
  });
});
