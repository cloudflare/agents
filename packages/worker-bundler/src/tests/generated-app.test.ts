import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import {
  createGeneratedApp,
  createGeneratedAppRebuilder,
  seedGeneratedAppWorkspace,
  serveGeneratedAppPreview,
  type GeneratedAppBuildState,
  type GeneratedAppWorkspaceLike
} from "../generated-app";
import type { CreateAppResult } from "../app";
import type { SourceProvider } from "../source-provider";

function createWorkspace(files = new Map<string, string>()) {
  const workspace: GeneratedAppWorkspaceLike = {
    async glob(pattern) {
      if (pattern.includes("*")) {
        const prefix = pattern.slice(0, pattern.indexOf("*"));
        return [...files.keys()]
          .filter((path) => path.startsWith(prefix))
          .map((path) => ({ path, type: "file" }));
      }
      return files.has(pattern) ? [{ path: pattern, type: "file" }] : [];
    },
    async exists(path) {
      return files.has(path);
    },
    async writeFile(path, content) {
      files.set(path, content);
    },
    async writeFileBytes(path, content) {
      files.set(path, Array.from(new Uint8Array(content)).join(","));
    }
  };
  return { files, workspace };
}

describe("seedGeneratedAppWorkspace", () => {
  it("backfills missing files without overwriting existing files", async () => {
    const { files, workspace } = createWorkspace(
      new Map([["/package.json", "custom"]])
    );

    const result = await seedGeneratedAppWorkspace(workspace, {
      files: {
        "/package.json": "seeded",
        "/src/index.ts": "index"
      }
    });

    expect(result).toEqual({ seeded: true });
    expect(files.get("/package.json")).toBe("custom");
    expect(files.get("/src/index.ts")).toBe("index");
  });

  it("can intentionally overwrite existing files", async () => {
    const { files, workspace } = createWorkspace(
      new Map([["/src/index.ts", "old"]])
    );

    await seedGeneratedAppWorkspace(workspace, {
      overwrite: true,
      files: {
        "/src/index.ts": "new"
      }
    });

    expect(files.get("/src/index.ts")).toBe("new");
  });
});

describe("createGeneratedAppRebuilder", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces multiple rebuild requests into one build", async () => {
    vi.useFakeTimers();
    let buildCount = 0;
    const states: GeneratedAppBuildState[] = [];
    const rebuilder = createGeneratedAppRebuilder({
      debounceMs: 20,
      build: async () => {
        buildCount++;
        return createResult();
      },
      onStateChange: (state) => {
        states.push(state);
      }
    });

    const first = rebuilder.requestRebuild("a");
    const second = rebuilder.requestRebuild("b");

    expect(first).toBe(second);
    expect(buildCount).toBe(0);

    await vi.advanceTimersByTimeAsync(20);
    const state = await second;

    expect(buildCount).toBe(1);
    expect(state.status).toBe("built");
    expect(state.previewVersion).toBe(1);
    expect(rebuilder.getResult()).toBeDefined();
    expect(states.map((entry) => entry.status)).toContain("scheduled");
    expect(states.map((entry) => entry.status)).toContain("building");
    expect(states.at(-1)?.status).toBe("built");
  });

  it("keeps the previous result when a later rebuild fails", async () => {
    let shouldFail = false;
    const rebuilder = createGeneratedAppRebuilder({
      build: async () => {
        if (shouldFail) throw new Error("boom");
        return createResult();
      }
    });

    await rebuilder.rebuildNow();
    const result = rebuilder.getResult();
    shouldFail = true;
    const failed = await rebuilder.rebuildNow();

    expect(failed.status).toBe("error");
    expect(failed.error).toBe("boom");
    expect(failed.previewVersion).toBe(1);
    expect(rebuilder.getResult()).toBe(result);
  });

  it("does not replace the current result if preview version persistence fails", async () => {
    let responseText = "first";
    let shouldFailVersionWrite = false;
    const rebuilder = createGeneratedAppRebuilder({
      build: async () => createResult(responseText),
      onPreviewVersionChange: async () => {
        if (shouldFailVersionWrite) throw new Error("storage unavailable");
      }
    });

    await rebuilder.rebuildNow();
    const firstResult = rebuilder.getResult();
    responseText = "second";
    shouldFailVersionWrite = true;
    const failed = await rebuilder.rebuildNow();

    expect(failed.status).toBe("error");
    expect(failed.error).toBe("storage unavailable");
    expect(failed.previewVersion).toBe(1);
    expect(rebuilder.getResult()).toBe(firstResult);
  });
});

describe("createGeneratedApp", () => {
  it("seeds, builds, and serves a generated app through one object", async () => {
    const { files, workspace } = createWorkspace();
    const source: SourceProvider = {
      async list() {
        return [...files.keys()].map((path) => ({
          path,
          type: "file" as const,
          kind: path.startsWith("/public/") ? ("asset" as const) : undefined
        }));
      },
      async readText(path) {
        return files.get(path) ?? null;
      }
    };
    const app = createGeneratedApp({
      workspace,
      seed: {
        files: {
          "/package.json": "{}",
          "/src/message.ts": "export const message = 'hello generated app';",
          "/public/index.html":
            "<!doctype html><script src='/client.js'></script>"
        }
      },
      source,
      virtualFiles: {
        "src/server.ts":
          "import { message } from './message'; export default { fetch() { return new Response(message); } };"
      },
      build: {
        server: "src/server.ts"
      },
      preview: {
        loader: env.LOADER,
        name: "generated-app-object-test"
      }
    });

    const state = await app.rebuildNow();
    const response = await app.serve(new Request("http://app/api"));

    expect(state.status).toBe("built");
    expect(state.previewVersion).toBe(1);
    expect(app.getResult()).toBeDefined();
    expect(await response.text()).toBe("hello generated app");
  });

  it("throws before rebuilding when serve is called without preview config", async () => {
    let buildCount = 0;
    const app = createGeneratedApp({
      source: {
        async list() {
          return [];
        },
        async readText() {
          return null;
        }
      },
      build: {
        server: "src/server.ts"
      },
      virtualFiles: () => {
        buildCount++;
        return {
          "src/server.ts":
            "export default { fetch() { return new Response('ok'); } };"
        };
      }
    });

    await expect(app.serve(new Request("http://app/"))).rejects.toThrow(
      "createGeneratedApp().serve() requires a `preview` option."
    );
    expect(buildCount).toBe(0);
  });
});

describe("serveGeneratedAppPreview", () => {
  it("uses previewVersion to load rebuilt worker code under a fresh name", async () => {
    const first = await createApp({
      files: {
        "src/index.ts":
          "export default { fetch() { return new Response('first'); } };"
      },
      server: "src/index.ts"
    });
    const second = await createApp({
      files: {
        "src/index.ts":
          "export default { fetch() { return new Response('second'); } };"
      },
      server: "src/index.ts"
    });

    const firstResponse = await serveGeneratedAppPreview(
      new Request("http://app/"),
      {
        result: first,
        loader: env.LOADER,
        loaderName: "generated-app-test",
        previewVersion: 1
      }
    );
    const secondResponse = await serveGeneratedAppPreview(
      new Request("http://app/"),
      {
        result: second,
        loader: env.LOADER,
        loaderName: "generated-app-test",
        previewVersion: 2
      }
    );

    expect(await firstResponse.text()).toBe("first");
    expect(await secondResponse.text()).toBe("second");
  });
});

function createResult(text = "ok"): CreateAppResult {
  return {
    mainModule: "index.js",
    modules: {
      "index.js": `export default { fetch() { return new Response(${JSON.stringify(text)}); } };`
    },
    assets: {},
    assetManifest: new Map()
  };
}
