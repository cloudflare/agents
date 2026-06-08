import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import think, {
  createThinkViteManifest,
  createThinkViteWorkerConfig,
  createThinkViteWorkerConfigResult,
  THINK_EXPERIMENTAL_NOTICE
} from "../vite";
import type { Plugin } from "vite";

const files = {
  "agents/support.ts": `
    import { Think } from "@cloudflare/think";
    export class SupportAgent extends Think<Env> {
      getModel() { return this.env.AI("@cf/model"); }
      getMessengers() { return {}; }
    }
  `
};

describe("Think Vite plugin", () => {
  it("creates manifests and Worker config from virtual project files", async () => {
    await expect(
      createThinkViteManifest({ files }, "/app")
    ).resolves.toMatchObject({
      root: "/app",
      agents: [{ id: "support", className: "ThinkAgent_Support" }],
      features: []
    });

    await expect(
      createThinkViteWorkerConfig({ files, name: "support-app" }, "/app")
    ).resolves.toMatchObject({
      name: "support-app",
      main: "virtual:think/entry",
      durable_objects: {
        bindings: [
          { name: "ThinkAgent_Support", class_name: "ThinkAgent_Support" }
        ]
      }
    });
  });

  it("returns diagnostics for the merged Worker config", async () => {
    const root = await mkdtemp(join(tmpdir(), "think-vite-"));
    await writeFile(
      join(root, "wrangler.jsonc"),
      JSON.stringify({
        main: "virtual:think/entry",
        durable_objects: { bindings: [] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["LegacyAgent"] }],
        assets: { run_worker_first: ["/custom/*"] }
      })
    );

    const result = await createThinkViteWorkerConfigResult({ files }, root);

    expect(result.config.durable_objects.bindings).toEqual([
      { name: "ThinkAgent_Support", class_name: "ThinkAgent_Support" }
    ]);
    expect(result.config.migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["LegacyAgent"] },
      { tag: "think-generated-v1", new_sqlite_classes: ["ThinkAgent_Support"] }
    ]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "custom-agent-routing",
          severity: "warning"
        })
      ])
    );
  });

  it("serves composable virtual modules", async () => {
    const plugins = flattenThinkPlugins(think({ files }));
    const frameworkPlugin = plugins.find(
      (plugin): plugin is Plugin => plugin.name === "@cloudflare/think"
    );

    expect(frameworkPlugin).toBeDefined();

    if (!frameworkPlugin) throw new Error("Think framework plugin not found");

    const resolveId = frameworkPlugin.resolveId as unknown as (
      this: typeof minimalPluginContext,
      source: string,
      importer: string | undefined,
      options: { attributes: Record<string, unknown>; isEntry: boolean }
    ) => unknown;
    const load = frameworkPlugin.load as unknown as (
      this: typeof minimalPluginContext,
      id: string
    ) => unknown | Promise<unknown>;

    const ids = [
      "virtual:think/agents",
      "virtual:think/config",
      "virtual:think/entry",
      "virtual:think/manifest",
      "virtual:think/router",
      "virtual:think/server-entry"
    ];

    for (const id of ids) {
      expect(
        resolveId.call(minimalPluginContext, id, undefined, {
          attributes: {},
          isEntry: false
        })
      ).toBe(`\0${id}`);
    }

    const agentsModule = await load.call(
      minimalPluginContext,
      "\0virtual:think/agents"
    );
    const entry = await load.call(
      minimalPluginContext,
      "\0virtual:think/entry"
    );
    const manifest = await load.call(
      minimalPluginContext,
      "\0virtual:think/manifest"
    );
    const router = await load.call(
      minimalPluginContext,
      "\0virtual:think/router"
    );

    expect(String(agentsModule)).toContain(
      `export { Agent0 as ThinkAgent_Support };`
    );
    expect(String(agentsModule)).toContain(`__resolveThinkAgentModule`);
    expect(String(entry)).toContain(`export * from "virtual:think/agents";`);
    expect(String(manifest)).toContain(`"className": "ThinkAgent_Support"`);
    expect(String(router)).toContain(`thinkRouter`);
  });

  it("warns with next steps when no agents are discovered", async () => {
    const plugins = flattenThinkPlugins(think({ files: {} }));
    const frameworkPlugin = plugins.find(
      (plugin): plugin is Plugin => plugin.name === "@cloudflare/think"
    );
    if (!frameworkPlugin) throw new Error("Think framework plugin not found");

    const warnings: string[] = [];
    const buildStart = frameworkPlugin.buildStart as unknown as (
      this: typeof minimalPluginContext,
      options: Record<string, unknown>
    ) => void | Promise<void>;

    await buildStart.call(
      {
        ...minimalPluginContext,
        warn(message?: unknown) {
          warnings.push(String(message));
        }
      },
      {}
    );

    expect(warnings).toEqual([
      THINK_EXPERIMENTAL_NOTICE,
      'No Think agents discovered. Add an agent file such as "agents/support.ts" exporting a Think subclass or "export default agent(...)".'
    ]);
  });

  it("watches Wrangler config files during build start", async () => {
    const plugins = flattenThinkPlugins(think({ files: {} }));
    const frameworkPlugin = plugins.find(
      (plugin): plugin is Plugin => plugin.name === "@cloudflare/think"
    );
    if (!frameworkPlugin) throw new Error("Think framework plugin not found");

    const watched: string[] = [];
    const buildStart = frameworkPlugin.buildStart as unknown as (
      this: typeof minimalPluginContext,
      options: Record<string, unknown>
    ) => void | Promise<void>;

    await buildStart.call(
      {
        ...minimalPluginContext,
        addWatchFile(file: string) {
          watched.push(file);
        }
      },
      {}
    );

    expect(watched).toEqual(
      expect.arrayContaining([
        expect.stringContaining("wrangler.jsonc"),
        expect.stringContaining("wrangler.json"),
        expect.stringContaining("wrangler.toml")
      ])
    );
  });

  it("prints a concise manifest summary when agents are discovered", async () => {
    const plugins = flattenThinkPlugins(think({ files }));
    const frameworkPlugin = plugins.find(
      (plugin): plugin is Plugin => plugin.name === "@cloudflare/think"
    );
    if (!frameworkPlugin) throw new Error("Think framework plugin not found");

    const infos: string[] = [];
    const buildStart = frameworkPlugin.buildStart as unknown as (
      this: typeof minimalPluginContext,
      options: Record<string, unknown>
    ) => void | Promise<void>;

    await buildStart.call(
      {
        ...minimalPluginContext,
        info(message?: unknown) {
          infos.push(String(message));
        }
      },
      {}
    );

    expect(infos).toEqual([
      [
        "Think framework manifest:",
        "Discovered 1 Think agent (1 top-level, 0 sub-agents).",
        "- support | class ThinkAgent_Support | /agents/support"
      ].join("\n")
    ]);
  });

  it("reports error diagnostics during build start", async () => {
    const root = await mkdtemp(join(tmpdir(), "think-vite-"));
    await writeFile(
      join(root, "wrangler.jsonc"),
      JSON.stringify({
        main: "src/server.ts",
        durable_objects: {
          bindings: [{ name: "Support", class_name: "ThinkAgent_Support" }]
        },
        migrations: [{ tag: "v1", new_sqlite_classes: ["ThinkAgent_Support"] }]
      })
    );
    const plugins = flattenThinkPlugins(think({ files }));
    const frameworkPlugin = plugins.find(
      (plugin): plugin is Plugin => plugin.name === "@cloudflare/think"
    );
    if (!frameworkPlugin) throw new Error("Think framework plugin not found");
    const configResolved =
      frameworkPlugin.configResolved as unknown as (config: {
        root: string;
      }) => void;
    const buildStart = frameworkPlugin.buildStart as unknown as (
      this: typeof minimalPluginContext,
      options: Record<string, unknown>
    ) => void | Promise<void>;
    const errors: string[] = [];

    configResolved({ root });
    await Promise.resolve(
      buildStart.call(
        {
          ...minimalPluginContext,
          error(error: string | Error): never {
            errors.push(typeof error === "string" ? error : error.message);
            throw new Error("captured error");
          }
        },
        {}
      )
    ).catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== "captured error") {
        throw error;
      }
    });

    expect(errors).toEqual([
      expect.stringContaining("[unexpected-worker-main]")
    ]);
  });

  it("generates host-style custom server fallthrough", async () => {
    const plugins = flattenThinkPlugins(
      think({
        files: {
          ...files,
          "src/server.ts": "export default { fetch() { return null; } }"
        }
      })
    );
    const frameworkPlugin = plugins.find(
      (plugin): plugin is Plugin => plugin.name === "@cloudflare/think"
    );
    if (!frameworkPlugin) throw new Error("Think framework plugin not found");
    const load = frameworkPlugin.load as unknown as (
      this: typeof minimalPluginContext,
      id: string
    ) => unknown | Promise<unknown>;

    const entry = await load.call(
      minimalPluginContext,
      "\0virtual:think/entry"
    );

    expect(String(entry)).toContain(
      `const response = await appEntrypoint.fetch(request, env, ctx, { router: thinkRouter });`
    );
    expect(String(entry)).toContain(`if (response) return response;`);
    expect(String(entry)).toContain(`thinkRouter.route(request, env, ctx)`);
  });
});

const minimalPluginContext = {
  addWatchFile(_file: string) {},
  debug() {},
  emitFile() {
    return "";
  },
  error(error: string | Error): never {
    throw typeof error === "string" ? new Error(error) : error;
  },
  getFileName() {
    return "";
  },
  getModuleIds() {
    return [][Symbol.iterator]();
  },
  getModuleInfo() {
    return null;
  },
  getWatchFiles() {
    return [];
  },
  info() {},
  load() {
    return null;
  },
  meta: {
    rollupVersion: "0.0.0",
    watchMode: false
  },
  parse() {
    return { type: "Program", body: [], sourceType: "module" };
  },
  resolve() {
    return null;
  },
  setAssetSource() {},
  warn(_message?: unknown) {}
};

function flattenThinkPlugins(options: ReturnType<typeof think>): Plugin[] {
  const plugins: Plugin[] = [];
  const visit = (option: unknown) => {
    if (!option) return;
    if (Array.isArray(option)) {
      for (const item of option) visit(item);
      return;
    }
    if (typeof option === "object" && "name" in option) {
      plugins.push(option as Plugin);
    }
  };

  visit(options);
  return plugins;
}
