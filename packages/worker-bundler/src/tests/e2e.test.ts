import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { createWorker } from "../index";
import { parseWranglerConfig, hasNodejsCompat } from "../config";
import { detectEntryPoint } from "../utils";
import type { CreateWorkerOptions, Files } from "../types";

let testId = 0;

/**
 * Build a worker with createWorker, load it into the Worker Loader,
 * call fetch(), and return the Response.
 */
async function buildAndFetch(
  options: CreateWorkerOptions,
  request: Request = new Request("http://worker/")
): Promise<Response> {
  const result = await createWorker(options);
  const id = "test-worker-" + testId++;
  const worker = env.LOADER.get(id, () => ({
    mainModule: result.mainModule,
    modules: result.modules,
    compatibilityDate: result.wranglerConfig?.compatibilityDate ?? "2026-01-01",
    compatibilityFlags: result.wranglerConfig?.compatibilityFlags
  }));
  return worker.getEntrypoint().fetch(request);
}

describe("createWorker e2e (build + load + fetch)", () => {
  it("bundles and runs a simple worker", async () => {
    const response = await buildAndFetch({
      files: {
        "src/index.ts": [
          "export default {",
          "  fetch() {",
          '    return new Response("hello");',
          "  }",
          "};"
        ].join("\n")
      }
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello");
  });

  it("bundles multiple files with relative imports", async () => {
    const response = await buildAndFetch({
      files: {
        "src/index.ts": [
          'import { greet } from "./utils";',
          "export default {",
          "  fetch() {",
          '    return new Response(greet("world"));',
          "  }",
          "};"
        ].join("\n"),
        "src/utils.ts": [
          "export function greet(name: string): string {",
          '  return "Hello, " + name + "!";',
          "}"
        ].join("\n")
      }
    });

    expect(await response.text()).toBe("Hello, world!");
  });

  it("respects explicit entryPoint option", async () => {
    const response = await buildAndFetch({
      files: {
        "worker.ts": [
          "export default {",
          "  fetch() {",
          '    return new Response("custom entry");',
          "  }",
          "};"
        ].join("\n")
      },
      entryPoint: "worker.ts"
    });

    expect(await response.text()).toBe("custom entry");
  });

  it("runs a worker that uses cloudflare:workers", async () => {
    const response = await buildAndFetch({
      files: {
        "src/index.ts": [
          'import { WorkerEntrypoint } from "cloudflare:workers";',
          "export default class extends WorkerEntrypoint {",
          "  fetch() {",
          '    return new Response("entrypoint works");',
          "  }",
          "}"
        ].join("\n")
      }
    });

    expect(await response.text()).toBe("entrypoint works");
  });

  it("runs a worker that reads the request", async () => {
    const response = await buildAndFetch(
      {
        files: {
          "src/index.ts": [
            "export default {",
            "  async fetch(request) {",
            "    const url = new URL(request.url);",
            '    return new Response("path: " + url.pathname);',
            "  }",
            "};"
          ].join("\n")
        }
      },
      new Request("http://worker/hello/world")
    );

    expect(await response.text()).toBe("path: /hello/world");
  });

  it("runs a worker that returns JSON", async () => {
    const response = await buildAndFetch({
      files: {
        "src/index.ts": [
          "export default {",
          "  fetch() {",
          '    return Response.json({ status: "ok", count: 42 });',
          "  }",
          "};"
        ].join("\n")
      }
    });

    expect(response.headers.get("content-type")).toContain("application/json");
    const data = await response.json();
    expect(data).toEqual({ status: "ok", count: 42 });
  });

  it("runs a minified worker", async () => {
    const response = await buildAndFetch({
      files: {
        "src/index.ts": [
          "export default {",
          "  fetch() {",
          '    const message = "minified";',
          "    return new Response(message);",
          "  }",
          "};"
        ].join("\n")
      },
      minify: true
    });

    expect(await response.text()).toBe("minified");
  });

  it(
    "installs npm dependencies and runs the worker",
    { timeout: 30_000 },
    async () => {
      const response = await buildAndFetch({
        files: {
          "src/index.ts": [
            'import { escape } from "he";',
            "export default {",
            "  fetch() {",
            '    return new Response(escape("<h1>hello</h1>"));',
            "  }",
            "};"
          ].join("\n"),
          "package.json": JSON.stringify({
            dependencies: { he: "^1.2.0" }
          })
        }
      });

      expect(response.status).toBe(200);
      const text = await response.text();
      // he.escape should HTML-encode the angle brackets
      expect(text).toContain("&lt;");
      expect(text).toContain("&gt;");
      expect(text).not.toContain("<h1>");
    }
  );

  it("runs a worker with wrangler.toml nodejs_compat", async () => {
    const response = await buildAndFetch({
      files: {
        "src/index.ts": [
          'import { Buffer } from "node:buffer";',
          "export default {",
          "  fetch() {",
          '    const buf = Buffer.from("hello");',
          '    return new Response(buf.toString("base64"));',
          "  }",
          "};"
        ].join("\n"),
        "wrangler.toml": [
          'main = "src/index.ts"',
          'compatibility_date = "2026-01-28"',
          'compatibility_flags = ["nodejs_compat"]'
        ].join("\n")
      }
    });

    expect(await response.text()).toBe("aGVsbG8=");
  });
});

describe("createWorker transform-only mode (build + load + fetch)", () => {
  it("transforms and runs a multi-file worker without bundling", async () => {
    const result = await createWorker({
      files: {
        "src/index.ts": [
          'import { greet } from "./utils";',
          "export default {",
          "  fetch() {",
          '    return new Response(greet("world"));',
          "  }",
          "};"
        ].join("\n"),
        "src/utils.ts": [
          "export function greet(name: string): string {",
          '  return "Hello, " + name + "!";',
          "}"
        ].join("\n")
      },
      bundle: false
    });

    expect(result.mainModule).toBe("src/index.js");
    expect(result.modules["src/index.js"]).toBeDefined();
    expect(result.modules["src/utils.js"]).toBeDefined();

    const id = "test-transform-" + testId++;
    const worker = env.LOADER.get(id, () => ({
      mainModule: result.mainModule,
      modules: result.modules,
      compatibilityDate: "2026-01-01"
    }));

    const response = await worker
      .getEntrypoint()
      .fetch(new Request("http://worker/"));
    expect(await response.text()).toBe("Hello, world!");
  });
});

describe("createWorker error cases", () => {
  it("throws when entry point is not found", async () => {
    await expect(
      createWorker({
        files: { "src/other.ts": "export const x = 1;" },
        entryPoint: "src/index.ts"
      })
    ).rejects.toThrow('Entry point "src/index.ts" not found');
  });

  it("throws when no entry point can be detected", async () => {
    await expect(
      createWorker({
        files: { "lib/other.ts": "export const x = 1;" }
      })
    ).rejects.toThrow("Could not determine entry point");
  });
});

describe("createWorker output validation", () => {
  it("treats cloudflare: modules as external in bundle", async () => {
    const result = await createWorker({
      files: {
        "src/index.ts": [
          'import { WorkerEntrypoint } from "cloudflare:workers";',
          "export default class extends WorkerEntrypoint {",
          '  fetch() { return new Response("ok"); }',
          "}"
        ].join("\n")
      }
    });

    const bundle = result.modules["bundle.js"] as string;
    expect(bundle).toContain("cloudflare:workers");
  });

  it("treats user-specified externals as external", async () => {
    const result = await createWorker({
      files: {
        "src/index.ts": [
          'import pg from "pg";',
          "export default {",
          "  fetch() { return new Response(pg.name); }",
          "};"
        ].join("\n")
      },
      externals: ["pg"]
    });

    const bundle = result.modules["bundle.js"] as string;
    expect(bundle).toContain("pg");
  });

  it("parses wrangler.toml and returns config", async () => {
    const result = await createWorker({
      files: {
        "src/index.ts":
          'export default { fetch() { return new Response("ok"); } };',
        "wrangler.toml": [
          'main = "src/index.ts"',
          'compatibility_date = "2026-01-01"',
          'compatibility_flags = ["nodejs_compat"]'
        ].join("\n")
      }
    });

    expect(result.wranglerConfig).toBeDefined();
    expect(result.wranglerConfig?.compatibilityDate).toBe("2026-01-01");
    expect(result.wranglerConfig?.compatibilityFlags).toContain(
      "nodejs_compat"
    );
  });

  it("supports sourcemap option", async () => {
    const result = await createWorker({
      files: {
        "src/index.ts":
          'export default { fetch() { return new Response("ok"); } };'
      },
      sourcemap: true
    });

    const bundle = result.modules["bundle.js"] as string;
    expect(bundle).toContain("sourceMappingURL");
  });

  it("supports minify option", async () => {
    const files = {
      "src/index.ts": [
        "export default {",
        "  fetch() {",
        '    const longVariableName = "hello";',
        "    return new Response(longVariableName);",
        "  }",
        "};"
      ].join("\n")
    };
    const unminified = await createWorker({ files, minify: false });
    const minified = await createWorker({ files, minify: true });

    const unminifiedSize = (unminified.modules["bundle.js"] as string).length;
    const minifiedSize = (minified.modules["bundle.js"] as string).length;
    expect(minifiedSize).toBeLessThan(unminifiedSize);
  });
});

describe("detectEntryPoint", () => {
  it("detects from wrangler config main", () => {
    const files: Files = { "src/worker.ts": "export default {}" };
    const config = { main: "src/worker.ts" };
    expect(detectEntryPoint(files, config)).toBe("src/worker.ts");
  });

  it("strips ./ from wrangler config main", () => {
    const files: Files = { "src/worker.ts": "export default {}" };
    const config = { main: "./src/worker.ts" };
    expect(detectEntryPoint(files, config)).toBe("src/worker.ts");
  });

  it("detects from package.json main field", () => {
    const files: Files = {
      "package.json": JSON.stringify({ main: "./lib/index.js" }),
      "lib/index.js": "export default {}"
    };
    expect(detectEntryPoint(files, undefined)).toBe("lib/index.js");
  });

  it("detects from package.json exports field", () => {
    const files: Files = {
      "package.json": JSON.stringify({
        exports: { ".": { import: "./src/entry.ts" } }
      }),
      "src/entry.ts": "export default {}"
    };
    expect(detectEntryPoint(files, undefined)).toBe("src/entry.ts");
  });

  it("falls back to src/index.ts default", () => {
    const files: Files = { "src/index.ts": "export default {}" };
    expect(detectEntryPoint(files, undefined)).toBe("src/index.ts");
  });

  it("falls back to index.ts default", () => {
    const files: Files = { "index.ts": "export default {}" };
    expect(detectEntryPoint(files, undefined)).toBe("index.ts");
  });

  it("returns undefined when no entry found", () => {
    const files: Files = { "lib/other.ts": "export const x = 1;" };
    expect(detectEntryPoint(files, undefined)).toBeUndefined();
  });
});

describe("parseWranglerConfig", () => {
  it("parses wrangler.toml", () => {
    const files: Files = {
      "wrangler.toml": [
        'main = "src/index.ts"',
        'compatibility_date = "2026-01-01"',
        'compatibility_flags = ["nodejs_compat"]'
      ].join("\n")
    };
    const config = parseWranglerConfig(files);
    expect(config).toBeDefined();
    expect(config?.main).toBe("src/index.ts");
    expect(config?.compatibilityDate).toBe("2026-01-01");
    expect(config?.compatibilityFlags).toEqual(["nodejs_compat"]);
  });

  it("parses wrangler.json", () => {
    const files: Files = {
      "wrangler.json": JSON.stringify({
        main: "src/index.ts",
        compatibility_date: "2026-01-01"
      })
    };
    const config = parseWranglerConfig(files);
    expect(config?.main).toBe("src/index.ts");
    expect(config?.compatibilityDate).toBe("2026-01-01");
  });

  it("parses wrangler.jsonc with comments", () => {
    const files: Files = {
      "wrangler.jsonc": [
        "{",
        "  // Entry point",
        '  "main": "src/index.ts",',
        "  /* Compat settings */",
        '  "compatibility_date": "2026-01-01"',
        "}"
      ].join("\n")
    };
    const config = parseWranglerConfig(files);
    expect(config?.main).toBe("src/index.ts");
    expect(config?.compatibilityDate).toBe("2026-01-01");
  });

  it("returns undefined when no config file exists", () => {
    const files: Files = { "src/index.ts": "export default {}" };
    expect(parseWranglerConfig(files)).toBeUndefined();
  });

  it("returns empty object for invalid toml", () => {
    const files: Files = { "wrangler.toml": "not valid toml {{{" };
    const config = parseWranglerConfig(files);
    expect(config).toEqual({});
  });
});

describe("hasNodejsCompat", () => {
  it("returns true when nodejs_compat is present", () => {
    expect(hasNodejsCompat({ compatibilityFlags: ["nodejs_compat"] })).toBe(
      true
    );
  });

  it("returns false when flag is absent", () => {
    expect(hasNodejsCompat({ compatibilityFlags: [] })).toBe(false);
  });

  it("returns false for undefined config", () => {
    expect(hasNodejsCompat(undefined)).toBe(false);
  });
});
