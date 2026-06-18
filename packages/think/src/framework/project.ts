import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseJsonc } from "aywson";
import { parse as parseToml } from "smol-toml";
import {
  createThinkWorkerConfig,
  createThinkWorkerDefaults,
  diagnoseThinkWorkerConfig,
  mergeThinkWorkerConfig,
  type ThinkConfigMergeResult,
  type ThinkWorkerConfigDiagnostic
} from "./config";
import { discoverThinkApp } from "./discovery";
import type {
  ThinkFrameworkManifest,
  ThinkWorkerConfig,
  ThinkWorkerConfigOptions
} from "./manifest";

export const WRANGLER_CONFIG_FILES = [
  "wrangler.jsonc",
  "wrangler.json",
  "wrangler.toml"
];

export interface ThinkProjectOptions extends ThinkWorkerConfigOptions {
  files?: Record<string, string>;
  manifest?: ThinkFrameworkManifest;
  allowNonVirtualMain?: boolean;
}

export interface ThinkWranglerConfigResult {
  config: Record<string, unknown> | null;
  error?: string;
  path?: string;
}

export async function resolveThinkManifest(
  options: ThinkProjectOptions,
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

export async function readProjectFiles(
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

export function watchWranglerConfigFiles(
  root: string,
  watchFile: (file: string) => void
): void {
  for (const file of WRANGLER_CONFIG_FILES) {
    watchFile(path.join(root, file));
  }
}

export function applyUserBindingNames(
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

export async function readWranglerConfig(
  root: string
): Promise<ThinkWranglerConfigResult> {
  for (const file of WRANGLER_CONFIG_FILES) {
    let source: string;
    try {
      source = await readFile(path.join(root, file), "utf8");
    } catch (error) {
      if (isMissingFileError(error)) continue;
      throw error;
    }
    try {
      return { config: parseWranglerConfig(file, source), path: file };
    } catch (error) {
      return {
        config: null,
        path: file,
        error:
          `Could not parse ${file} for Think diagnostics: ${
            error instanceof Error ? error.message : String(error)
          }. ` +
          `Fix the config syntax to enable binding and route diagnostics.`
      };
    }
  }

  return { config: null };
}

function parseWranglerConfig(
  file: string,
  source: string
): Record<string, unknown> {
  if (file.endsWith(".toml")) {
    return parseToml(source) as Record<string, unknown>;
  }
  return parseJsonc(source) as Record<string, unknown>;
}

export async function createThinkProjectWorkerConfigResult(
  options: ThinkProjectOptions = {},
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

export async function createThinkProject(
  options: ThinkProjectOptions = {},
  root = process.cwd()
): Promise<{
  manifest: ThinkFrameworkManifest;
  workerConfig: ThinkWorkerConfig;
  diagnostics: ThinkWorkerConfigDiagnostic[];
  wranglerConfig: ThinkWranglerConfigResult;
}> {
  const manifest = await resolveThinkManifest(options, root);
  const wranglerConfig = await readWranglerConfig(root);
  if (!wranglerConfig.config) {
    const workerConfig = createThinkWorkerConfig(manifest, options);
    return {
      manifest,
      workerConfig,
      wranglerConfig,
      diagnostics: diagnoseThinkWorkerConfig(manifest, workerConfig, {
        allowNonVirtualMain: options.allowNonVirtualMain
      })
    };
  }

  applyUserBindingNames(manifest, wranglerConfig.config);
  const mergeResult = mergeThinkWorkerConfig(
    wranglerConfig.config,
    createThinkWorkerDefaults(manifest, options)
  );
  return {
    manifest,
    workerConfig: mergeResult.config,
    wranglerConfig,
    diagnostics: [
      ...mergeResult.diagnostics,
      ...diagnoseThinkWorkerConfig(manifest, mergeResult.config, {
        allowNonVirtualMain: options.allowNonVirtualMain,
        routeConfig: wranglerConfig.config
      })
    ]
  };
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
