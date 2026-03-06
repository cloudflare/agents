import { describe, it, expect } from "vitest";
import {
  handleAssetRequest,
  buildAssetManifest,
  buildAssets,
  createMemoryStorage,
  normalizeConfig,
  computeETag
} from "../asset-handler";
import type {
  AssetConfig,
  AssetManifest,
  AssetStorage
} from "../asset-handler";
import { inferContentType, isTextContentType } from "../mime";

// ── Helper: build manifest + storage from assets ────────────────────

async function makeAssets(
  assets: Record<string, string | ArrayBuffer>
): Promise<{ manifest: AssetManifest; storage: AssetStorage }> {
  return buildAssets(assets);
}

// ── MIME type tests ─────────────────────────────────────────────────

describe("inferContentType", () => {
  it("returns correct MIME type for common extensions", () => {
    expect(inferContentType("/index.html")).toBe("text/html; charset=utf-8");
    expect(inferContentType("/app.js")).toBe(
      "application/javascript; charset=utf-8"
    );
    expect(inferContentType("/styles.css")).toBe("text/css; charset=utf-8");
    expect(inferContentType("/data.json")).toBe(
      "application/json; charset=utf-8"
    );
    expect(inferContentType("/logo.png")).toBe("image/png");
    expect(inferContentType("/photo.jpg")).toBe("image/jpeg");
    expect(inferContentType("/icon.svg")).toBe("image/svg+xml");
    expect(inferContentType("/favicon.ico")).toBe("image/x-icon");
    expect(inferContentType("/font.woff2")).toBe("font/woff2");
    expect(inferContentType("/doc.pdf")).toBe("application/pdf");
    expect(inferContentType("/app.wasm")).toBe("application/wasm");
  });

  it("is case-insensitive for extensions", () => {
    expect(inferContentType("/FILE.HTML")).toBe("text/html; charset=utf-8");
    expect(inferContentType("/SCRIPT.JS")).toBe(
      "application/javascript; charset=utf-8"
    );
  });

  it("returns undefined for unknown extensions", () => {
    expect(inferContentType("/file.xyz")).toBeUndefined();
    expect(inferContentType("/noext")).toBeUndefined();
  });

  it("handles paths with multiple dots", () => {
    expect(inferContentType("/app.bundle.js")).toBe(
      "application/javascript; charset=utf-8"
    );
    expect(inferContentType("/styles.min.css")).toBe("text/css; charset=utf-8");
  });
});

describe("isTextContentType", () => {
  it("returns true for text types", () => {
    expect(isTextContentType("text/html; charset=utf-8")).toBe(true);
    expect(isTextContentType("text/css; charset=utf-8")).toBe(true);
    expect(isTextContentType("application/json; charset=utf-8")).toBe(true);
    expect(isTextContentType("application/javascript; charset=utf-8")).toBe(
      true
    );
    expect(isTextContentType("image/svg+xml")).toBe(true);
  });

  it("returns false for binary types", () => {
    expect(isTextContentType("image/png")).toBe(false);
    expect(isTextContentType("image/jpeg")).toBe(false);
    expect(isTextContentType("font/woff2")).toBe(false);
    expect(isTextContentType("application/pdf")).toBe(false);
    expect(isTextContentType("application/wasm")).toBe(false);
  });
});

// ── ETag computation tests ──────────────────────────────────────────

describe("computeETag", () => {
  it("returns a string for text content", async () => {
    const etag = await computeETag("hello world");
    expect(typeof etag).toBe("string");
    expect(etag.length).toBeGreaterThan(0);
  });

  it("returns consistent values for same content", async () => {
    const a = await computeETag("hello");
    const b = await computeETag("hello");
    expect(a).toBe(b);
  });

  it("returns different values for different content", async () => {
    const a = await computeETag("hello");
    const b = await computeETag("world");
    expect(a).not.toBe(b);
  });

  it("works with ArrayBuffer", async () => {
    const buf = new TextEncoder().encode("hello").buffer;
    const etag = await computeETag(buf);
    expect(typeof etag).toBe("string");
    expect(etag.length).toBeGreaterThan(0);
  });
});

// ── buildAssetManifest tests ────────────────────────────────────────

describe("buildAssetManifest", () => {
  it("builds a manifest from path->content", async () => {
    const manifest = await buildAssetManifest({
      "/index.html": "<h1>Hello</h1>",
      "/app.js": "console.log('hi')"
    });
    expect(manifest.size).toBe(2);
    expect(manifest.get("/index.html")).toBeDefined();
    expect(manifest.get("/app.js")).toBeDefined();
  });

  it("infers content types", async () => {
    const manifest = await buildAssetManifest({
      "/index.html": "<h1>Hello</h1>",
      "/app.js": "console.log('hi')",
      "/unknown": "data"
    });
    expect(manifest.get("/index.html")?.contentType).toBe(
      "text/html; charset=utf-8"
    );
    expect(manifest.get("/app.js")?.contentType).toBe(
      "application/javascript; charset=utf-8"
    );
    expect(manifest.get("/unknown")?.contentType).toBeUndefined();
  });

  it("computes etags", async () => {
    const manifest = await buildAssetManifest({
      "/a.html": "hello",
      "/b.html": "world"
    });
    expect(manifest.get("/a.html")?.etag).toBeDefined();
    expect(manifest.get("/b.html")?.etag).toBeDefined();
    expect(manifest.get("/a.html")?.etag).not.toBe(
      manifest.get("/b.html")?.etag
    );
  });
});

// ── createMemoryStorage tests ───────────────────────────────────────

describe("createMemoryStorage", () => {
  it("returns content for known pathnames", async () => {
    const storage = createMemoryStorage({ "/a.txt": "hello" });
    expect(await storage.get("/a.txt")).toBe("hello");
  });

  it("returns null for unknown pathnames", async () => {
    const storage = createMemoryStorage({ "/a.txt": "hello" });
    expect(await storage.get("/missing")).toBeNull();
  });
});

// ── handleAssetRequest tests ────────────────────────────────────────

describe("handleAssetRequest — basic serving", () => {
  it("serves an exact-match asset with correct content type", async () => {
    const { manifest, storage } = await makeAssets({
      "/index.html": "<!DOCTYPE html><h1>Hi</h1>",
      "/app.js": "console.log('hello')"
    });

    const res = await handleAssetRequest(
      new Request("http://example.com/app.js"),
      manifest,
      storage
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("Content-Type")).toBe(
      "application/javascript; charset=utf-8"
    );
    expect(await res!.text()).toBe("console.log('hello')");
  });

  it("serves HTML with correct content type", async () => {
    const { manifest, storage } = await makeAssets({
      "/index.html": "<h1>Home</h1>"
    });

    const res = await handleAssetRequest(
      new Request("http://example.com/"),
      manifest,
      storage
    );
    expect(res).not.toBeNull();
    expect(res!.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  it("returns null for non-existent assets (fall-through)", async () => {
    const { manifest, storage } = await makeAssets({
      "/index.html": "<h1>Home</h1>"
    });

    const res = await handleAssetRequest(
      new Request("http://example.com/api/data"),
      manifest,
      storage,
      { html_handling: "none", not_found_handling: "none" }
    );
    expect(res).toBeNull();
  });

  it("returns null for POST requests (fall-through)", async () => {
    const { manifest, storage } = await makeAssets({
      "/index.html": "<h1>Home</h1>"
    });

    const res = await handleAssetRequest(
      new Request("http://example.com/index.html", { method: "POST" }),
      manifest,
      storage
    );
    expect(res).toBeNull();
  });

  it("handles HEAD requests with no body", async () => {
    const { manifest, storage } = await makeAssets({
      "/app.js": "console.log('hello')"
    });

    const res = await handleAssetRequest(
      new Request("http://example.com/app.js", { method: "HEAD" }),
      manifest,
      storage
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.body).toBeNull();
    expect(res!.headers.get("Content-Type")).toBe(
      "application/javascript; charset=utf-8"
    );
  });
});

// ── ETag / 304 tests ────────────────────────────────────────────────

describe("handleAssetRequest — ETag and conditional requests", () => {
  it("includes ETag header in response", async () => {
    const { manifest, storage } = await makeAssets({
      "/app.js": "console.log('hello')"
    });

    const res = await handleAssetRequest(
      new Request("http://example.com/app.js"),
      manifest,
      storage
    );
    expect(res).not.toBeNull();
    const etag = res!.headers.get("ETag");
    expect(etag).toBeTruthy();
    expect(etag!.startsWith('"')).toBe(true);
    expect(etag!.endsWith('"')).toBe(true);
  });

  it("returns 304 when If-None-Match matches strong ETag", async () => {
    const { manifest, storage } = await makeAssets({
      "/app.js": "console.log('hello')"
    });

    const first = await handleAssetRequest(
      new Request("http://example.com/app.js"),
      manifest,
      storage
    );
    const etag = first!.headers.get("ETag")!;

    const second = await handleAssetRequest(
      new Request("http://example.com/app.js", {
        headers: { "If-None-Match": etag }
      }),
      manifest,
      storage
    );
    expect(second).not.toBeNull();
    expect(second!.status).toBe(304);
    expect(second!.body).toBeNull();
  });

  it("returns 304 when If-None-Match matches weak ETag", async () => {
    const { manifest, storage } = await makeAssets({
      "/app.js": "console.log('hello')"
    });

    const first = await handleAssetRequest(
      new Request("http://example.com/app.js"),
      manifest,
      storage
    );
    const strongEtag = first!.headers.get("ETag")!;
    const weakEtag = `W/${strongEtag}`;

    const second = await handleAssetRequest(
      new Request("http://example.com/app.js", {
        headers: { "If-None-Match": weakEtag }
      }),
      manifest,
      storage
    );
    expect(second).not.toBeNull();
    expect(second!.status).toBe(304);
  });

  it("returns 200 when If-None-Match does not match", async () => {
    const { manifest, storage } = await makeAssets({
      "/app.js": "console.log('hello')"
    });

    const res = await handleAssetRequest(
      new Request("http://example.com/app.js", {
        headers: { "If-None-Match": '"stale-etag"' }
      }),
      manifest,
      storage
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
  });
});

// ── Cache-Control tests ─────────────────────────────────────────────

describe("handleAssetRequest — Cache-Control", () => {
  it("sets must-revalidate for HTML files", async () => {
    const { manifest, storage } = await makeAssets({
      "/index.html": "<h1>Home</h1>"
    });

    const res = await handleAssetRequest(
      new Request("http://example.com/"),
      manifest,
      storage
    );
    expect(res!.headers.get("Cache-Control")).toBe(
      "public, max-age=0, must-revalidate"
    );
  });

  it("sets immutable for hashed assets", async () => {
    const { manifest, storage } = await makeAssets({
      "/app.a1b2c3d4.js": "console.log('versioned')"
    });

    const res = await handleAssetRequest(
      new Request("http://example.com/app.a1b2c3d4.js"),
      manifest,
      storage
    );
    expect(res!.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable"
    );
  });

  it("sets must-revalidate for non-hashed JS", async () => {
    const { manifest, storage } = await makeAssets({
      "/app.js": "console.log('hello')"
    });

    const res = await handleAssetRequest(
      new Request("http://example.com/app.js"),
      manifest,
      storage
    );
    expect(res!.headers.get("Cache-Control")).toBe(
      "public, max-age=0, must-revalidate"
    );
  });
});

// ── SPA fallback tests ──────────────────────────────────────────────

describe("handleAssetRequest — SPA fallback", () => {
  it("serves /index.html for unknown routes with SPA config", async () => {
    const { manifest, storage } = await makeAssets({
      "/index.html": "<!DOCTYPE html><div id='root'></div>",
      "/app.js": "console.log('app')"
    });

    const res = await handleAssetRequest(
      new Request("http://example.com/dashboard/settings", {
        headers: { Accept: "text/html,application/xhtml+xml" }
      }),
      manifest,
      storage,
      { not_found_handling: "single-page-application" }
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(await res!.text()).toBe("<!DOCTYPE html><div id='root'></div>");
  });

  it("does NOT serve SPA fallback for non-HTML requests (API calls)", async () => {
    const { manifest, storage } = await makeAssets({
      "/index.html": "<!DOCTYPE html><div id='root'></div>"
    });

    const res = await handleAssetRequest(
      new Request("http://example.com/api/counter"),
      manifest,
      storage,
      { not_found_handling: "single-page-application" }
    );
    expect(res).toBeNull();
  });

  it("still serves exact matches over SPA fallback", async () => {
    const { manifest, storage } = await makeAssets({
      "/index.html": "<h1>Home</h1>",
      "/about.html": "<h1>About</h1>"
    });

    const res = await handleAssetRequest(
      new Request("http://example.com/about"),
      manifest,
      storage,
      { not_found_handling: "single-page-application" }
    );
    expect(res).not.toBeNull();
    expect(await res!.text()).toBe("<h1>About</h1>");
  });

  it("falls through for unknown routes without SPA config", async () => {
    const { manifest, storage } = await makeAssets({
      "/index.html": "<h1>Home</h1>"
    });

    const res = await handleAssetRequest(
      new Request("http://example.com/api/data"),
      manifest,
      storage,
      { html_handling: "none", not_found_handling: "none" }
    );
    expect(res).toBeNull();
  });
});

// ── 404.html handling tests ─────────────────────────────────────────

describe("handleAssetRequest — 404-page handling", () => {
  it("serves /404.html for unknown routes", async () => {
    const { manifest, storage } = await makeAssets({
      "/index.html": "<h1>Home</h1>",
      "/404.html": "<h1>Not Found</h1>"
    });

    const res = await handleAssetRequest(
      new Request("http://example.com/unknown"),
      manifest,
      storage,
      { not_found_handling: "404-page" }
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
    expect(await res!.text()).toBe("<h1>Not Found</h1>");
  });

  it("walks up directory tree for nested 404.html", async () => {
    const { manifest, storage } = await makeAssets({
      "/index.html": "<h1>Home</h1>",
      "/blog/404.html": "<h1>Blog Not Found</h1>",
      "/404.html": "<h1>Root Not Found</h1>"
    });

    const res = await handleAssetRequest(
      new Request("http://example.com/blog/nonexistent"),
      manifest,
      storage,
      { not_found_handling: "404-page" }
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
    expect(await res!.text()).toBe("<h1>Blog Not Found</h1>");
  });

  it("falls back to root 404.html if nested one is missing", async () => {
    const { manifest, storage } = await makeAssets({
      "/index.html": "<h1>Home</h1>",
      "/404.html": "<h1>Root Not Found</h1>"
    });

    const res = await handleAssetRequest(
      new Request("http://example.com/blog/nonexistent"),
      manifest,
      storage,
      { not_found_handling: "404-page" }
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
    expect(await res!.text()).toBe("<h1>Root Not Found</h1>");
  });
});

// ── HTML handling: auto-trailing-slash ───────────────────────────────

describe("handleAssetRequest — auto-trailing-slash", () => {
  it("serves /about via /about.html", async () => {
    const { manifest, storage } = await makeAssets({
      "/about.html": "<h1>About</h1>"
    });

    const res = await handleAssetRequest(
      new Request("http://example.com/about"),
      manifest,
      storage,
      { html_handling: "auto-trailing-slash" }
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(await res!.text()).toBe("<h1>About</h1>");
  });

  it("serves /blog/ via /blog/index.html", async () => {
    const { manifest, storage } = await makeAssets({
      "/blog/index.html": "<h1>Blog</h1>"
    });

    const res = await handleAssetRequest(
      new Request("http://example.com/blog/"),
      manifest,
      storage,
      { html_handling: "auto-trailing-slash" }
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(await res!.text()).toBe("<h1>Blog</h1>");
  });

  it("serves / via /index.html", async () => {
    const { manifest, storage } = await makeAssets({
      "/index.html": "<h1>Home</h1>"
    });

    const res = await handleAssetRequest(
      new Request("http://example.com/"),
      manifest,
      storage,
      { html_handling: "auto-trailing-slash" }
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(await res!.text()).toBe("<h1>Home</h1>");
  });

  it("serves exact binary files without HTML resolution", async () => {
    const { manifest, storage } = await makeAssets({
      "/logo.png": "PNG_DATA"
    });

    const res = await handleAssetRequest(
      new Request("http://example.com/logo.png"),
      manifest,
      storage,
      { html_handling: "auto-trailing-slash" }
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(await res!.text()).toBe("PNG_DATA");
  });
});

// ── HTML handling: none ─────────────────────────────────────────────

describe("handleAssetRequest — html_handling: none", () => {
  it("only serves exact matches", async () => {
    const { manifest, storage } = await makeAssets({
      "/about.html": "<h1>About</h1>"
    });

    const res = await handleAssetRequest(
      new Request("http://example.com/about"),
      manifest,
      storage,
      { html_handling: "none", not_found_handling: "none" }
    );
    expect(res).toBeNull();
  });

  it("serves exact .html path", async () => {
    const { manifest, storage } = await makeAssets({
      "/about.html": "<h1>About</h1>"
    });

    const res = await handleAssetRequest(
      new Request("http://example.com/about.html"),
      manifest,
      storage,
      { html_handling: "none" }
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
  });
});

// ── Redirect tests ──────────────────────────────────────────────────

describe("handleAssetRequest — redirects", () => {
  it("handles static redirects", async () => {
    const { manifest, storage } = await makeAssets({
      "/index.html": "<h1>Home</h1>"
    });

    const res = await handleAssetRequest(
      new Request("http://example.com/old"),
      manifest,
      storage,
      {
        redirects: {
          static: { "/old": { status: 301, to: "/new" } }
        }
      }
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(301);
    expect(res!.headers.get("Location")).toBe("/new");
  });

  it("handles dynamic redirects with placeholders", async () => {
    const { manifest, storage } = await makeAssets({
      "/index.html": "<h1>Home</h1>"
    });

    const res = await handleAssetRequest(
      new Request("http://example.com/blog/my-post"),
      manifest,
      storage,
      {
        redirects: {
          dynamic: { "/blog/:slug": { status: 302, to: "/posts/:slug" } }
        }
      }
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(302);
    expect(res!.headers.get("Location")).toContain("/posts/my-post");
  });

  it("handles dynamic redirects with splat", async () => {
    const { manifest, storage } = await makeAssets({
      "/index.html": "<h1>Home</h1>"
    });

    const res = await handleAssetRequest(
      new Request("http://example.com/old/path/to/page"),
      manifest,
      storage,
      {
        redirects: {
          dynamic: { "/old/*": { status: 301, to: "/new/*" } }
        }
      }
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(301);
  });

  it("handles 200 proxy redirects (rewrite)", async () => {
    const { manifest, storage } = await makeAssets({
      "/index.html": "<h1>Home</h1>",
      "/users/id.html": "<h1>User Page</h1>"
    });

    const res = await handleAssetRequest(
      new Request("http://example.com/users/12345"),
      manifest,
      storage,
      {
        html_handling: "none",
        redirects: {
          static: { "/users/12345": { status: 200, to: "/users/id.html" } }
        }
      }
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(await res!.text()).toBe("<h1>User Page</h1>");
  });
});

// ── Custom headers tests ────────────────────────────────────────────

describe("handleAssetRequest — custom headers", () => {
  it("applies custom headers matching the path", async () => {
    const { manifest, storage } = await makeAssets({
      "/index.html": "<h1>Home</h1>"
    });

    const res = await handleAssetRequest(
      new Request("http://example.com/index.html"),
      manifest,
      storage,
      {
        headers: {
          "/*": { set: { "X-Custom": "hello", "X-Frame-Options": "DENY" } }
        }
      }
    );
    expect(res).not.toBeNull();
    expect(res!.headers.get("X-Custom")).toBe("hello");
    expect(res!.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("applies path-specific headers", async () => {
    const { manifest, storage } = await makeAssets({
      "/api.html": "<h1>API</h1>",
      "/index.html": "<h1>Home</h1>"
    });

    const config: AssetConfig = {
      headers: { "/api*": { set: { "X-API": "true" } } }
    };

    const apiRes = await handleAssetRequest(
      new Request("http://example.com/api.html"),
      manifest,
      storage,
      config
    );
    expect(apiRes!.headers.get("X-API")).toBe("true");

    const homeRes = await handleAssetRequest(
      new Request("http://example.com/index.html"),
      manifest,
      storage,
      config
    );
    expect(homeRes!.headers.get("X-API")).toBeNull();
  });

  it("unsets headers", async () => {
    const { manifest, storage } = await makeAssets({
      "/index.html": "<h1>Home</h1>"
    });

    const res = await handleAssetRequest(
      new Request("http://example.com/index.html"),
      manifest,
      storage,
      { headers: { "/*": { unset: ["ETag"] } } }
    );
    expect(res).not.toBeNull();
    expect(res!.headers.get("ETag")).toBeNull();
  });
});

// ── normalizeConfig tests ───────────────────────────────────────────

describe("normalizeConfig", () => {
  it("returns defaults when no config provided", () => {
    const config = normalizeConfig();
    expect(config.html_handling).toBe("auto-trailing-slash");
    expect(config.not_found_handling).toBe("none");
    expect(config.redirects.static).toEqual({});
    expect(config.redirects.dynamic).toEqual({});
    expect(config.headers).toEqual({});
  });

  it("preserves user-provided values", () => {
    const config = normalizeConfig({
      html_handling: "none",
      not_found_handling: "single-page-application"
    });
    expect(config.html_handling).toBe("none");
    expect(config.not_found_handling).toBe("single-page-application");
  });

  it("assigns line numbers to static redirects", () => {
    const config = normalizeConfig({
      redirects: {
        static: {
          "/a": { status: 301, to: "/b" },
          "/c": { status: 302, to: "/d" }
        }
      }
    });
    expect(config.redirects.static["/a"].lineNumber).toBe(1);
    expect(config.redirects.static["/c"].lineNumber).toBe(2);
  });
});
