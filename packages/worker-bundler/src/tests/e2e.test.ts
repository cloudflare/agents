import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createWorker, installDependencies } from "../index";
import { isCloudflareWorkersRuntime, NOT_IN_WORKERS_ERROR } from "../bundler";
import { parseWranglerConfig, hasNodejsCompat } from "../config";
import { detectEntryPoint } from "../utils";
import { runInDurableObject } from "cloudflare:test";
import { InMemoryFileSystem, DurableObjectKVFileSystem } from "../file-system";
import type { CreateWorkerOptions } from "../types";
import { createTypescriptLanguageService } from "../typescript";

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

// Shared fixtures used by the installer and FileSystem integration tests.
// is-number@7.0.0 is a minimal, dependency-free npm package.
const PACKAGE_JSON = JSON.stringify({ dependencies: { "is-number": "7.0.0" } });
const WORKER_SRC = [
  'import isNumber from "is-number";',
  "export default {",
  "  fetch() { return new Response(String(isNumber(42))); }",
  "};"
].join("\n");

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

describe("createWorker advanced bundler options", () => {
  it("applies define replacements at bundle time", async () => {
    const response = await buildAndFetch({
      files: {
        "src/index.ts": [
          "declare const __GREETING__: string;",
          "export default {",
          "  fetch() { return new Response(__GREETING__); }",
          "};"
        ].join("\n")
      },
      define: {
        __GREETING__: '"hello from define"'
      }
    });

    expect(await response.text()).toBe("hello from define");
  });

  it("respects per-extension loader overrides (.svg as text)", async () => {
    const response = await buildAndFetch({
      files: {
        "src/index.ts": [
          'import logo from "./logo.svg";',
          "export default {",
          "  fetch() { return new Response(logo); }",
          "};"
        ].join("\n"),
        "src/logo.svg": "<svg>hello</svg>"
      },
      loader: {
        ".svg": "text"
      }
    });

    expect(await response.text()).toBe("<svg>hello</svg>");
  });

  it("longer extension wins in loader overrides", async () => {
    // ".d.ts" should beat ".ts" — both match, but the longer one is more specific.
    const response = await buildAndFetch({
      files: {
        "src/index.ts": [
          'import doc from "./readme.d.ts";',
          "export default {",
          "  fetch() { return new Response(doc); }",
          "};"
        ].join("\n"),
        "src/readme.d.ts": "docs-as-text"
      },
      loader: {
        ".ts": "ts",
        ".d.ts": "text"
      }
    });

    expect(await response.text()).toBe("docs-as-text");
  });

  it("runs user esbuild plugins before the internal virtual-fs plugin", async () => {
    // A user plugin claims `virtual:greeting` before virtual-fs ever sees it.
    const greetingPlugin = {
      name: "test-greeting",
      setup(build: {
        onResolve: (
          opts: { filter: RegExp },
          cb: (args: { path: string }) => unknown
        ) => void;
        onLoad: (
          opts: { filter: RegExp; namespace: string },
          cb: (args: { path: string }) => unknown
        ) => void;
      }) {
        build.onResolve({ filter: /^virtual:/ }, (args) => ({
          path: args.path,
          namespace: "test-greeting"
        }));
        build.onLoad({ filter: /.*/, namespace: "test-greeting" }, (_args) => ({
          contents: 'export const greeting = "hi from a plugin";',
          loader: "ts"
        }));
      }
    };

    const response = await buildAndFetch({
      files: {
        "src/index.ts": [
          'import { greeting } from "virtual:greeting";',
          "export default {",
          "  fetch() { return new Response(greeting); }",
          "};"
        ].join("\n")
      },
      __dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired: [greetingPlugin]
    });

    expect(await response.text()).toBe("hi from a plugin");
  });

  it("threads jsx + jsxImportSource through to the bundle output", async () => {
    // We don't have React in the test fixtures, so just verify that the
    // automatic runtime references the configured import source instead of
    // looking for a React global.
    const result = await createWorker({
      files: {
        "src/index.tsx": [
          "export default {",
          "  fetch() {",
          "    const el = <div>hello</div>;",
          "    return new Response(JSON.stringify(el));",
          "  }",
          "};"
        ].join("\n")
      },
      // .tsx isn't in the default entry-point detection list.
      entryPoint: "src/index.tsx",
      jsx: "automatic",
      jsxImportSource: "preact",
      // The classic transform requires React in scope; with `automatic` esbuild
      // emits an import from `${jsxImportSource}/jsx-runtime`. Mark it external
      // so the bundle compiles without us having to actually install preact.
      externals: ["preact"]
    });

    const bundle = result.modules["bundle.js"] as string;
    expect(bundle).toContain("preact/jsx-runtime");
  });

  it("rejects plugin entries that aren't shaped like esbuild plugins", async () => {
    await expect(
      createWorker({
        files: {
          "src/index.ts":
            "export default { fetch() { return new Response('ok'); } };"
        },
        __dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired: [
          // Missing `setup`.
          { name: "broken" } as unknown
        ]
      })
    ).rejects.toThrow(
      /__dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired\[0\] is not a valid esbuild plugin/
    );
  });

  it("rejects null / non-object plugin entries with a clear error", async () => {
    await expect(
      createWorker({
        files: {
          "src/index.ts":
            "export default { fetch() { return new Response('ok'); } };"
        },
        __dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired: [
          null as unknown
        ]
      })
    ).rejects.toThrow(
      /__dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired\[0\]/
    );
  });

  it("warns when bundler-only options are set with bundle: false", async () => {
    const result = await createWorker({
      files: {
        "src/index.ts": [
          "export default {",
          "  fetch() { return new Response('hi'); }",
          "};"
        ].join("\n")
      },
      bundle: false,
      // None of these can apply in transform-only mode.
      define: { __X__: "1" },
      jsx: "automatic",
      conditions: ["workerd"]
    });

    expect(result.warnings).toBeDefined();
    const message = result.warnings!.find((w) =>
      w.includes("ignored when `bundle: false`")
    );
    expect(message).toBeDefined();
    expect(message).toContain("define");
    expect(message).toContain("jsx");
    expect(message).toContain("conditions");
  });

  it("does NOT warn when bundle: false is used without bundler-only options", async () => {
    const result = await createWorker({
      files: {
        "src/index.ts":
          "export default { fetch() { return new Response('hi'); } };"
      },
      bundle: false
    });

    const offending = (result.warnings ?? []).find((w) =>
      w.includes("ignored when `bundle: false`")
    );
    expect(offending).toBeUndefined();
  });
});

describe("createWorker error cases", () => {
  it("throws when entry point is not found and lists available files", async () => {
    await expect(
      createWorker({
        files: { "src/other.ts": "export const x = 1;" },
        entryPoint: "src/index.ts"
      })
    ).rejects.toThrow(
      /Entry point "src\/index.ts" was not found.*src\/other\.ts/
    );
  });

  it("throws when no entry point can be detected", async () => {
    await expect(
      createWorker({
        files: { "lib/other.ts": "export const x = 1;" }
      })
    ).rejects.toThrow("Could not determine entry point");
  });
});

describe("non-Workers runtime guard", () => {
  // The bundler refuses to load esbuild.wasm outside Workers because Node's
  // ESM-WASM loader can't resolve esbuild's `gojs` import namespace
  // (cloudflare/agents#1306). Verify the runtime guard fires before the
  // .wasm file is ever touched, and that the error message points users at
  // @cloudflare/vitest-pool-workers.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("isCloudflareWorkersRuntime() reflects navigator.userAgent", () => {
    expect(isCloudflareWorkersRuntime()).toBe(true);

    vi.stubGlobal("navigator", { userAgent: "node" });
    expect(isCloudflareWorkersRuntime()).toBe(false);

    vi.stubGlobal("navigator", undefined);
    expect(isCloudflareWorkersRuntime()).toBe(false);
  });

  it("NOT_IN_WORKERS_ERROR mentions vitest-pool-workers as the fix", () => {
    expect(NOT_IN_WORKERS_ERROR).toMatch(/@cloudflare\/vitest-pool-workers/);
    expect(NOT_IN_WORKERS_ERROR).toMatch(/Cloudflare Workers runtime/);
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

describe("installDependencies (standalone)", () => {
  it("installs packages into a FileSystem and reports what was installed", async () => {
    const fs = new InMemoryFileSystem({
      "package.json": PACKAGE_JSON,
      "src/index.ts": WORKER_SRC
    });

    const result = await installDependencies(fs);

    expect(result.warnings).toHaveLength(0);
    expect(result.installed).toContain("is-number@7.0.0");
    expect(fs.read("node_modules/is-number/package.json")).not.toBeNull();
  });

  it("skips packages whose node_modules entry already exists in the filesystem", async () => {
    // Pre-seed is-number to simulate a filesystem loaded from a prior install
    // (e.g. a DO KV store that was flushed and reloaded).
    const fs = new InMemoryFileSystem({
      "package.json": PACKAGE_JSON,
      "node_modules/is-number/package.json": JSON.stringify({
        name: "is-number",
        version: "7.0.0"
      }),
      "node_modules/is-number/index.js": "// stub module"
    });

    const result = await installDependencies(fs);

    // Nothing should have been fetched — the package was already present.
    expect(result.installed).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("createWorker does not re-install packages already present from a prior installDependencies call", async () => {
    const fs = new InMemoryFileSystem({
      "package.json": PACKAGE_JSON,
      "src/index.ts": WORKER_SRC
    });

    // Pre-install independently — this is the only place a real network fetch
    // should occur.
    const installResult = await installDependencies(fs);
    expect(installResult.installed).toContain("is-number@7.0.0");

    // Spy on fetch after the first install. Any call during createWorker would
    // mean the skip guard failed and a redundant network request was made.
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      const workerResult = await createWorker({ files: fs });
      expect(workerResult.mainModule).toBe("bundle.js");
      expect(workerResult.warnings).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("installDependencies + createTypeChecker e2e", () => {
  it("installs worker types into a filesystem and typechecks a worker source", async () => {
    const fs = new InMemoryFileSystem({
      "package.json": JSON.stringify({
        dependencies: {
          "@cloudflare/workers-types": "^4.20260405.1"
        }
      }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          lib: ["es2024"],
          target: "ES2024",
          module: "ES2022",
          moduleResolution: "bundler",
          allowSyntheticDefaultImports: true,
          strict: true,
          skipLibCheck: true,
          types: ["@cloudflare/workers-types/index.d.ts"]
        }
      }),
      "src/index.ts": [
        "const worker: ExportedHandler = {",
        "async fetch() {",
        '    return new Response("10");',
        "  }",
        "};",
        "",
        "export default worker;"
      ].join("\n")
    });

    const installResult = await installDependencies(fs);

    expect(
      installResult.installed.some((pkg) =>
        pkg.startsWith("@cloudflare/workers-types@")
      )
    ).toBe(true);
    expect(
      fs.read("node_modules/@cloudflare/workers-types/package.json")
    ).not.toBeNull();

    const { languageService } = await createTypescriptLanguageService({
      fileSystem: fs
    });

    const compilerOptionsDiagnostics =
      await languageService.getCompilerOptionsDiagnostics();
    const semanticDiagnostics =
      await languageService.getSemanticDiagnostics("src/index.ts");

    expect(compilerOptionsDiagnostics).toEqual([]);
    expect(semanticDiagnostics).toEqual([]);
  });
});

describe("createWorker with explicit FileSystem instances", () => {
  // These tests verify that createWorker works correctly when given an explicit
  // FileSystem instance rather than a plain Files object, and that the installer
  // writes node_modules entries back into the provided FileSystem so they are
  // immediately readable and (for DO storage) persist to KV after flush().

  it("InMemoryFileSystem: bundles correctly and node_modules are populated", async () => {
    const fs = new InMemoryFileSystem({
      "package.json": PACKAGE_JSON,
      "src/index.ts": WORKER_SRC
    });

    const result = await createWorker({ files: fs });

    expect(result.mainModule).toBe("bundle.js");
    expect(typeof result.modules["bundle.js"]).toBe("string");

    // The installer should have written is-number into the InMemoryFileSystem.
    expect(fs.read("node_modules/is-number/package.json")).not.toBeNull();

    // Smoke-test: load and run the bundled worker.
    const id = "test-worker-" + testId++;
    const worker = env.LOADER.get(id, () => ({
      mainModule: result.mainModule,
      modules: result.modules,
      compatibilityDate: "2026-01-01"
    }));
    const response = await worker
      .getEntrypoint()
      .fetch(new Request("http://worker/"));
    expect(await response.text()).toBe("true");
  });

  it("DurableObjectKVFileSystem: bundles correctly, node_modules readable from overlay then persisted to KV after flush", async () => {
    const stub = env.FS_TEST.get(env.FS_TEST.idFromName("bundler-do-fs"));

    await runInDurableObject(stub, async (_instance, state) => {
      const doFs = new DurableObjectKVFileSystem(state.storage);
      doFs.write("package.json", PACKAGE_JSON);
      doFs.write("src/index.ts", WORKER_SRC);

      const result = await createWorker({ files: doFs });

      expect(result.mainModule).toBe("bundle.js");
      expect(typeof result.modules["bundle.js"]).toBe("string");

      // Before flush, the installer's writes are buffered in the overlay and
      // readable immediately via read().
      expect(doFs.read("node_modules/is-number/package.json")).not.toBeNull();

      // And since we haven't flushed yet, the KV should be empty
      expect(
        state.storage.kv.get<string>(
          "bundle/node_modules/is-number/package.json"
        )
      ).toBeUndefined();

      // After flush, every overlay entry is persisted to Durable Object KV.
      await doFs.flush();
      expect(
        state.storage.kv.get<string>(
          "bundle/node_modules/is-number/package.json"
        )
      ).not.toBeNull();
    });
  });
});

describe("detectEntryPoint", () => {
  it("detects from wrangler config main", () => {
    const files = new InMemoryFileSystem({
      "src/worker.ts": "export default {}"
    });
    const config = { main: "src/worker.ts" };
    expect(detectEntryPoint(files, config)).toBe("src/worker.ts");
  });

  it("strips ./ from wrangler config main", () => {
    const files = new InMemoryFileSystem({
      "src/worker.ts": "export default {}"
    });
    const config = { main: "./src/worker.ts" };
    expect(detectEntryPoint(files, config)).toBe("src/worker.ts");
  });

  it("detects from package.json main field", () => {
    const files = new InMemoryFileSystem({
      "package.json": JSON.stringify({ main: "./lib/index.js" }),
      "lib/index.js": "export default {}"
    });
    expect(detectEntryPoint(files, undefined)).toBe("lib/index.js");
  });

  it("detects from package.json exports field", () => {
    const files = new InMemoryFileSystem({
      "package.json": JSON.stringify({
        exports: { ".": { import: "./src/entry.ts" } }
      }),
      "src/entry.ts": "export default {}"
    });
    expect(detectEntryPoint(files, undefined)).toBe("src/entry.ts");
  });

  it("falls back to src/index.ts default", () => {
    const files = new InMemoryFileSystem({
      "src/index.ts": "export default {}"
    });
    expect(detectEntryPoint(files, undefined)).toBe("src/index.ts");
  });

  it("falls back to index.ts default", () => {
    const files = new InMemoryFileSystem({ "index.ts": "export default {}" });
    expect(detectEntryPoint(files, undefined)).toBe("index.ts");
  });

  it("returns undefined when no entry found", () => {
    const files = new InMemoryFileSystem({
      "lib/other.ts": "export const x = 1;"
    });
    expect(detectEntryPoint(files, undefined)).toBeUndefined();
  });
});

describe("parseWranglerConfig", () => {
  it("parses wrangler.toml", () => {
    const files = new InMemoryFileSystem({
      "wrangler.toml": [
        'main = "src/index.ts"',
        'compatibility_date = "2026-01-01"',
        'compatibility_flags = ["nodejs_compat"]'
      ].join("\n")
    });
    const config = parseWranglerConfig(files);
    expect(config).toBeDefined();
    expect(config?.main).toBe("src/index.ts");
    expect(config?.compatibilityDate).toBe("2026-01-01");
    expect(config?.compatibilityFlags).toEqual(["nodejs_compat"]);
  });

  it("parses wrangler.json", () => {
    const files = new InMemoryFileSystem({
      "wrangler.json": JSON.stringify({
        main: "src/index.ts",
        compatibility_date: "2026-01-01"
      })
    });
    const config = parseWranglerConfig(files);
    expect(config?.main).toBe("src/index.ts");
    expect(config?.compatibilityDate).toBe("2026-01-01");
  });

  it("parses wrangler.jsonc with comments", () => {
    const files = new InMemoryFileSystem({
      "wrangler.jsonc": [
        "{",
        "  // Entry point",
        '  "main": "src/index.ts",',
        "  /* Compat settings */",
        '  "compatibility_date": "2026-01-01"',
        "}"
      ].join("\n")
    });
    const config = parseWranglerConfig(files);
    expect(config?.main).toBe("src/index.ts");
    expect(config?.compatibilityDate).toBe("2026-01-01");
  });

  it("returns undefined when no config file exists", () => {
    const files = new InMemoryFileSystem({
      "src/index.ts": "export default {}"
    });
    expect(parseWranglerConfig(files)).toBeUndefined();
  });

  it("returns empty object for invalid toml", () => {
    const files = new InMemoryFileSystem({
      "wrangler.toml": "not valid toml {{{"
    });
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
