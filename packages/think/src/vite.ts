import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import agents from "agents/vite";
import type { Plugin, PluginOption, ResolvedConfig, ViteDevServer } from "vite";
import {
  createThinkWorkerConfig,
  diagnoseThinkWorkerConfig,
  mergeThinkWorkerConfig,
  createThinkWorkerDefaults,
  summarizeThinkManifest,
  type ThinkConfigMergeResult,
  type ThinkWorkerConfigDiagnostic
} from "./framework/config";
import {
  generateThinkAgentsModule,
  generateThinkConfigModule,
  generateThinkEntry,
  generateThinkManifestModule,
  generateThinkRouterModule,
  generateThinkServerEntryModule
} from "./framework/codegen";
import { createVirtualModule } from "./framework/virtual";
import type {
  ThinkFrameworkManifest,
  ThinkWorkerConfig,
  ThinkWorkerConfigOptions
} from "./framework/manifest";
import {
  applyUserBindingNames,
  readWranglerConfig,
  resolveThinkManifest,
  watchWranglerConfigFiles
} from "./framework/project";

export interface ThinkVitePluginOptions extends ThinkWorkerConfigOptions {
  files?: Record<string, string>;
  manifest?: ThinkFrameworkManifest;
  allowNonVirtualMain?: boolean;
  /**
   * Register the dev-server `s` shortcut that launches Think Studio against the
   * running instance. Defaults to `true` (only active when the prebuilt Studio
   * bundle ships with this package and the dev server runs in an interactive
   * TTY).
   */
  studioShortcut?: boolean;
}

// This module is built to `dist/vite.js`, so the CLI entry and the prebuilt
// Studio bundle are siblings under `dist/`.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const STUDIO_INDEX = path.join(moduleDir, "studio", "index.html");
const CLI_ENTRY = path.join(moduleDir, "cli", "index.js");

/** Derive `host`/`protocol` of the running dev server for `think studio`. */
function devServerTarget(server: ViteDevServer): {
  host: string;
  secure: boolean;
} {
  const local = server.resolvedUrls?.local?.[0];
  if (local) {
    try {
      const url = new URL(local);
      return { host: url.host, secure: url.protocol === "https:" };
    } catch {
      // fall through to the configured port
    }
  }
  const port = server.config.server.port ?? 5173;
  return { host: `localhost:${port}`, secure: false };
}

const virtualModules = {
  agents: createVirtualModule("virtual:think/agents"),
  config: createVirtualModule("virtual:think/config"),
  entry: createVirtualModule("virtual:think/entry"),
  manifest: createVirtualModule("virtual:think/manifest"),
  router: createVirtualModule("virtual:think/router"),
  serverEntry: createVirtualModule("virtual:think/server-entry")
};

export const THINK_EXPERIMENTAL_NOTICE =
  "The @cloudflare/think framework layer (Vite plugin and `think` CLI) is " +
  "experimental and may change or be removed in any release.";

export function think(options: ThinkVitePluginOptions = {}): PluginOption[] {
  let config: ResolvedConfig | null = null;
  let manifest: ThinkFrameworkManifest | null = options.manifest ?? null;
  let warnedExperimental = false;

  let studioChild: ChildProcess | null = null;

  const frameworkPlugin: Plugin = {
    name: "@cloudflare/think",
    enforce: "pre",
    configResolved(resolved) {
      config = resolved;
    },
    configureServer(server) {
      if (options.studioShortcut === false) return;

      const launchStudio = () => {
        // The Studio bundle + CLI ship in `dist`; guard for source checkouts
        // where the package hasn't been built.
        if (!existsSync(STUDIO_INDEX) || !existsSync(CLI_ENTRY)) {
          server.config.logger.warn(
            "Think Studio isn't available — build @cloudflare/think to generate the Studio bundle."
          );
          return;
        }
        if (studioChild && studioChild.exitCode === null) {
          server.config.logger.info("Think Studio is already running.");
          return;
        }
        const { host, secure } = devServerTarget(server);
        const args = [
          CLI_ENTRY,
          "studio",
          "--host",
          host,
          "--root",
          server.config.root
        ];
        if (secure) args.push("--protocol", "wss");
        server.config.logger.info(`\nLaunching Think Studio for ${host}…`);
        // Ignore the child's stdin so it doesn't contend with Vite's shortcut
        // readline; inherit stdout/stderr so its URL and logs are visible.
        studioChild = spawn(process.execPath, args, {
          stdio: ["ignore", "inherit", "inherit"]
        });
        studioChild.on("exit", () => {
          studioChild = null;
        });
        studioChild.on("error", (error) => {
          server.config.logger.error(
            `Failed to launch Think Studio: ${error.message}`
          );
          studioChild = null;
        });
      };

      const registerShortcut = () => {
        server.bindCLIShortcuts({
          customShortcuts: [
            {
              key: "s",
              description: "open Think Studio",
              action: () => launchStudio()
            }
          ]
        });
      };

      // `bindCLIShortcuts` is a no-op until `server.httpServer` is listening, so
      // register once it's up. Vite's own post-`listen` bind then merges custom
      // shortcuts on top of the defaults (via `_shortcutsState`), so `s` survives
      // alongside r/u/o/c/q.
      if (server.httpServer?.listening) registerShortcut();
      else server.httpServer?.once("listening", registerShortcut);

      server.httpServer?.once("close", () => {
        studioChild?.kill();
        studioChild = null;
      });
    },
    async buildStart() {
      if (!warnedExperimental) {
        warnedExperimental = true;
        this.warn(THINK_EXPERIMENTAL_NOTICE);
      }
      const root = config?.root ?? process.cwd();
      manifest = await resolveThinkManifest(options, root, (file) =>
        this.addWatchFile(file)
      );
      watchWranglerConfigFiles(root, (file) => this.addWatchFile(file));
      if (manifest.agents.length === 0) {
        this.warn(
          'No Think agents discovered. Add an agent file such as "agents/support.ts" exporting a Think subclass or "export default agent(...)".'
        );
      } else {
        this.info(
          [
            "Think framework manifest:",
            ...summarizeThinkManifest(manifest)
          ].join("\n")
        );
      }
      const userConfigResult = await readWranglerConfig(root);
      if (userConfigResult.error) {
        this.warn(userConfigResult.error);
      }
      if (userConfigResult.config) {
        applyUserBindingNames(manifest, userConfigResult.config);
        const mergeResult = mergeThinkWorkerConfig(
          userConfigResult.config,
          createThinkWorkerDefaults(manifest, options)
        );
        for (const diagnostic of diagnoseThinkWorkerConfig(
          manifest,
          mergeResult.config,
          {
            allowNonVirtualMain: options.allowNonVirtualMain,
            routeConfig: userConfigResult.config
          }
        ).concat(mergeResult.diagnostics)) {
          reportDiagnostic(
            diagnostic,
            (message) => this.error(message),
            (message) => this.info(message),
            (message) => this.warn(message)
          );
        }
      } else {
        for (const diagnostic of diagnoseThinkWorkerConfig(
          manifest,
          createThinkWorkerDefaults(manifest, options),
          { allowNonVirtualMain: options.allowNonVirtualMain }
        )) {
          reportDiagnostic(
            diagnostic,
            (message) => this.error(message),
            (message) => this.info(message),
            (message) => this.warn(message)
          );
        }
      }
    },
    resolveId(id) {
      for (const virtualModule of Object.values(virtualModules)) {
        const resolved = virtualModule.resolve(id);
        if (resolved) return resolved;
      }
      return null;
    },
    async load(id) {
      const current =
        manifest ??
        (await resolveThinkManifest(options, config?.root ?? process.cwd()));
      if (virtualModules.agents.matches(id)) {
        return generateThinkAgentsModule(current);
      }
      if (virtualModules.config.matches(id)) {
        return generateThinkConfigModule(current);
      }
      if (virtualModules.entry.matches(id)) {
        return generateThinkEntry(current);
      }
      if (virtualModules.manifest.matches(id)) {
        return generateThinkManifestModule(current);
      }
      if (virtualModules.router.matches(id)) {
        return generateThinkRouterModule(current);
      }
      if (virtualModules.serverEntry.matches(id)) {
        return generateThinkServerEntryModule();
      }
      return null;
    }
  };

  return [...agents(), frameworkPlugin];
}

export default think;

export async function createThinkViteManifest(
  options: ThinkVitePluginOptions = {},
  root = process.cwd()
): Promise<ThinkFrameworkManifest> {
  return resolveThinkManifest(options, root);
}

export async function createThinkViteWorkerConfig(
  options: ThinkVitePluginOptions = {},
  root = process.cwd()
): Promise<ThinkWorkerConfig> {
  return (await createThinkViteWorkerConfigResult(options, root)).config;
}

export async function createThinkViteWorkerConfigResult(
  options: ThinkVitePluginOptions = {},
  root = process.cwd()
): Promise<ThinkConfigMergeResult> {
  const manifest = await resolveThinkManifest(options, root);
  const userConfig = await readWranglerConfig(root);
  if (!userConfig.config) {
    const config = createThinkWorkerConfig(manifest, options);
    return {
      config,
      diagnostics: diagnoseThinkWorkerConfig(manifest, config, {
        allowNonVirtualMain: options.allowNonVirtualMain
      })
    };
  }
  applyUserBindingNames(manifest, userConfig.config);
  const result = mergeThinkWorkerConfig(
    userConfig.config,
    createThinkWorkerDefaults(manifest, options)
  );
  return {
    config: result.config,
    diagnostics: [
      ...result.diagnostics,
      ...diagnoseThinkWorkerConfig(manifest, result.config, {
        allowNonVirtualMain: options.allowNonVirtualMain,
        routeConfig: userConfig.config
      })
    ]
  };
}

function reportDiagnostic(
  diagnostic: ThinkWorkerConfigDiagnostic,
  error: (message: string) => void,
  info: (message: string) => void,
  warn: (message: string) => void
): void {
  const message = `[${diagnostic.code}] ${diagnostic.message}`;
  if (diagnostic.severity === "error") {
    error(message);
    return;
  }
  if (diagnostic.severity === "info") {
    info(message);
    return;
  }
  warn(message);
}
