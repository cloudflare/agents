import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import agents from "agents/vite";
import { parse as parseJsonc } from "aywson";
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
import { discoverThinkApp } from "./framework/discovery";
import type {
  ThinkFrameworkManifest,
  ThinkWorkerConfig,
  ThinkWorkerConfigOptions
} from "./framework/manifest";

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

const WRANGLER_CONFIG_FILES = [
  "wrangler.jsonc",
  "wrangler.json",
  "wrangler.toml"
];

export function think(options: ThinkVitePluginOptions = {}): PluginOption[] {
  let config: ResolvedConfig | null = null;
  let manifest: ThinkFrameworkManifest | null = options.manifest ?? null;

  const frameworkPlugin: Plugin = {
    name: "@cloudflare/think",
    enforce: "pre",
    configResolved(resolved) {
      config = resolved;
    },
    async buildStart() {
      const root = config?.root ?? process.cwd();
      manifest = await resolveManifest(options, root, (file) =>
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
        (await resolveManifest(options, config?.root ?? process.cwd()));
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
  return resolveManifest(options, root);
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
  const manifest = await resolveManifest(options, root);
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

async function resolveManifest(
  options: ThinkVitePluginOptions,
  root: string,
  watchFile?: (file: string) => void
): Promise<ThinkFrameworkManifest> {
  if (options.manifest) return options.manifest;
  if (options.files) {
    return discoverThinkApp({
      root,
      files: options.files,
      routePrefix: options.routePrefix
    });
  }
  return discoverThinkApp({
    root,
    routePrefix: options.routePrefix,
    files: await readProjectFiles(root, "agents", watchFile)
  });
}

async function readProjectFiles(
  root: string,
  directory: string,
  watchFile?: (file: string) => void
): Promise<Record<string, string>> {
  const absolute = path.join(root, directory);
  const files: Record<string, string> = {};
  watchFile?.(absolute);
  await readDirectory(root, absolute, files, watchFile);
  await readOptionalProjectFile(root, "src/server.ts", files, watchFile);
  return files;
}

function watchWranglerConfigFiles(
  root: string,
  watchFile: (file: string) => void
): void {
  for (const file of WRANGLER_CONFIG_FILES) {
    watchFile(path.join(root, file));
  }
}

async function readOptionalProjectFile(
  root: string,
  relativePath: string,
  files: Record<string, string>,
  watchFile?: (file: string) => void
): Promise<void> {
  try {
    const absolute = path.join(root, relativePath);
    files[relativePath] = await readFile(absolute, "utf8");
    watchFile?.(absolute);
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }
}

async function readDirectory(
  root: string,
  directory: string,
  files: Record<string, string>,
  watchFile?: (file: string) => void
): Promise<void> {
  let entries: Array<{
    isDirectory(): boolean;
    isFile(): boolean;
    name: string;
  }>;
  try {
    watchFile?.(directory);
    entries = await readdir(directory, {
      withFileTypes: true,
      encoding: "utf8"
    });
  } catch (error) {
    if (isMissingDirectoryError(error)) return;
    throw error;
  }

  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await readDirectory(root, absolute, files, watchFile);
      continue;
    }
    if (!entry.isFile()) continue;
    const relative = path.relative(root, absolute).replace(/\\/g, "/");
    watchFile?.(absolute);
    files[relative] = await readFile(absolute, "utf8");
  }
}

function applyUserBindingNames(
  manifest: ThinkFrameworkManifest,
  userConfig: Record<string, unknown>
): void {
  const bindings = readBindingArray(
    asRecord(asRecord(userConfig).durable_objects).bindings
  );
  for (const agent of manifest.agents) {
    if (agent.kind !== "top-level") continue;
    const binding = bindings.find(
      (candidate) => candidate.class_name === agent.className
    );
    agent.bindingName = binding?.name ?? agent.className;
  }
}

function readBindingArray(
  value: unknown
): Array<{ name: string; class_name: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    if (
      typeof record.name !== "string" ||
      typeof record.class_name !== "string"
    ) {
      return [];
    }
    return [{ name: record.name, class_name: record.class_name }];
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function isMissingDirectoryError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isMissingFileError(error: unknown): boolean {
  return isMissingDirectoryError(error);
}

async function readWranglerConfig(
  root: string
): Promise<{ config: Record<string, unknown> | null; error?: string }> {
  for (const file of ["wrangler.jsonc", "wrangler.json"]) {
    try {
      const source = await readFile(path.join(root, file), "utf8");
      return { config: parseJsonc(source) as Record<string, unknown> };
    } catch (error) {
      if (isMissingFileError(error)) continue;
      if (error instanceof SyntaxError) {
        return {
          config: null,
          error:
            `Could not parse ${file} for Think diagnostics: ${error.message}. ` +
            `Fix the JSONC syntax to enable binding and route diagnostics.`
        };
      }
      throw error;
    }
  }

  return { config: null };
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
