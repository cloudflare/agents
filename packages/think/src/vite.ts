import agents from "agents/vite";
import type { Plugin, PluginOption, ResolvedConfig } from "vite";
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

  const frameworkPlugin: Plugin = {
    name: "@cloudflare/think",
    enforce: "pre",
    configResolved(resolved) {
      config = resolved;
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
