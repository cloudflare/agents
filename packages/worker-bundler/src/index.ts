/**
 * Dynamic Worker Bundler
 *
 * Creates worker bundles from source files for Cloudflare's Worker Loader binding.
 */

import { bundleWithEsbuild, bundlerOnlyOptionsWarning } from "./bundler";
import { hasNodejsCompat, parseWranglerConfig } from "./config";
import { hasDependencies, installDependencies } from "./installer";
import { transformAndResolve } from "./transformer";
import type { CreateWorkerOptions, CreateWorkerResult } from "./types";
import {
  DEFAULT_ENTRY_POINTS,
  detectEntryPoint,
  formatFileListForError
} from "./utils";
import { showExperimentalWarning } from "./experimental";
import {
  InMemoryFileSystem,
  isFileSystem,
  type FileSystem
} from "./file-system";
import { materializeSourceProvider } from "./source-provider";

// Re-export types
export type {
  BundlerLoader,
  CreateWorkerOptions,
  CreateWorkerResult,
  Files,
  JsxMode,
  Modules,
  WranglerConfig
} from "./types";
export { isSourceProvider, materializeSourceProvider } from "./source-provider";
export type {
  MaterializedSource,
  SourceEntry,
  SourceEntryKind,
  SourceProvider,
  SourceProviderMaterializeOptions
} from "./source-provider";

// Re-export app bundler
export { createApp } from "./app";
export type { CreateAppOptions, CreateAppResult } from "./app";
export {
  buildGeneratedApp,
  createGeneratedApp,
  createGeneratedAppRebuilder,
  seedGeneratedAppWorkspace,
  serveGeneratedAppPreview
} from "./generated-app";
export type {
  GeneratedApp,
  GeneratedAppBuildState,
  GeneratedAppBuildStatus,
  GeneratedAppOptions,
  GeneratedAppPreviewOptions,
  GeneratedAppRebuilder,
  GeneratedAppRebuilderOptions,
  GeneratedAppSeed,
  GeneratedAppWorkspaceLike
} from "./generated-app";

// Re-export asset handler
export {
  handleAssetRequest,
  buildAssetManifest,
  buildAssets,
  createMemoryStorage
} from "./asset-handler";
export type {
  AssetConfig,
  AssetMetadata,
  AssetManifest,
  AssetStorage
} from "./asset-handler";

// Re-export MIME utilities
export { inferContentType, isTextContentType } from "./mime";

// Re-export file-system
export {
  createFileSystemSnapshot,
  DurableObjectKVFileSystem,
  DurableObjectRawFileSystem,
  InMemoryFileSystem,
  type FileSystem
} from "./file-system";

// Re-export installer utilities
export {
  installDependencies,
  hasDependencies,
  type InstallResult
} from "./installer";

/**
 * Creates a worker bundle from source files.
 *
 * This function performs:
 * 1. Entry point detection (from package.json or defaults)
 * 2. Auto-installation of npm dependencies (if package.json has dependencies)
 * 3. TypeScript/JSX transformation (via Sucrase)
 * 4. Module resolution (handling imports/exports)
 * 5. Optional bundling (combining all modules into one)
 *
 * @param options - Configuration options
 * @returns The main module path and all modules
 */
export async function createWorker(
  options: CreateWorkerOptions
): Promise<CreateWorkerResult> {
  showExperimentalWarning("createWorker");
  let {
    files,
    source,
    sourceOptions,
    bundle = true,
    externals = [],
    target = "es2022",
    minify = false,
    sourcemap = false,
    registry,
    jsx,
    jsxImportSource,
    define,
    loader,
    conditions,
    __dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired: plugins
  } = options;

  let fileSystem: FileSystem;
  let sourceWarnings: string[] = [];
  if (files && source) {
    throw new Error(
      "createWorker accepts either `files` or `source`, not both."
    );
  }
  if (source) {
    const materialized = await materializeSourceProvider(source, sourceOptions);
    fileSystem = materialized.fileSystem;
    sourceWarnings = materialized.warnings;
    const assetPaths = Object.keys(materialized.assets);
    if (assetPaths.length > 0) {
      sourceWarnings.push(
        `createWorker ignored ${assetPaths.length} SourceProvider asset${assetPaths.length === 1 ? "" : "s"} because Worker bundles do not include host-served assets. Use createApp() for full-stack apps with static assets.`
      );
    }
  } else if (files && isFileSystem(files)) {
    fileSystem = files;
  } else if (files) {
    fileSystem = new InMemoryFileSystem(files);
  } else {
    throw new Error("createWorker requires either `files` or `source`.");
  }
  const inputDescription = source ? "input sources" : "`files`";

  // Always treat cloudflare:* modules as external (runtime-provided)
  externals = ["cloudflare:", ...externals];

  // Parse wrangler config for compatibility settings
  const wranglerConfig = parseWranglerConfig(fileSystem);
  const nodejsCompat = hasNodejsCompat(wranglerConfig);

  // Auto-install dependencies if package.json has dependencies
  const installWarnings: string[] = [];
  if (hasDependencies(fileSystem)) {
    const installResult = await installDependencies(
      fileSystem,
      registry ? { registry } : {}
    );
    installWarnings.push(...installResult.warnings);
  }

  // Detect entry point (priority: explicit option > wrangler main > package.json > defaults)
  const entryPoint =
    options.entryPoint ?? detectEntryPoint(fileSystem, wranglerConfig);

  if (!entryPoint) {
    throw new Error(
      `Could not determine entry point for createWorker. Tried (in order): the \`entryPoint\` option, \`main\` in wrangler config, \`exports\`/\`module\`/\`main\` in package.json, and the defaults ${DEFAULT_ENTRY_POINTS.join(", ")}. Pass \`entryPoint\` explicitly or add one of those files.`
    );
  }

  if (fileSystem.read(entryPoint) === null) {
    throw new Error(
      `Entry point "${entryPoint}" was not found in ${inputDescription}. Available files: ${formatFileListForError(fileSystem)}.`
    );
  }

  if (bundle) {
    // Try bundling with esbuild-wasm
    const result = await bundleWithEsbuild({
      files: fileSystem,
      entryPoint,
      externals,
      target,
      minify,
      sourcemap,
      nodejsCompat,
      jsx,
      jsxImportSource,
      define,
      loader,
      conditions,
      plugins
    });

    // Add wrangler config if a config file was found
    if (wranglerConfig !== undefined) {
      result.wranglerConfig = wranglerConfig;
    }

    // Add install warnings to result
    const extraWarnings = [...sourceWarnings, ...installWarnings];
    if (extraWarnings.length > 0) {
      result.warnings = [...(result.warnings ?? []), ...extraWarnings];
    }

    return result;
  } else {
    // No bundling - transform files and resolve dependencies.
    // Sourcemaps and the esbuild-only options (jsx, jsxImportSource, define,
    // loader, conditions, plugins) are not supported in transform mode — the
    // output mirrors the input structure and never touches esbuild.
    const result = await transformAndResolve(fileSystem, entryPoint, externals);

    const bundlerOnly = bundlerOnlyOptionsWarning({
      jsx,
      jsxImportSource,
      define,
      loader,
      conditions,
      plugins
    });

    // Add wrangler config if a config file was found
    if (wranglerConfig !== undefined) {
      result.wranglerConfig = wranglerConfig;
    }

    // Add install warnings to result
    const extraWarnings = [
      ...sourceWarnings,
      ...installWarnings,
      ...(bundlerOnly ? [bundlerOnly] : [])
    ];
    if (extraWarnings.length > 0) {
      result.warnings = [...(result.warnings ?? []), ...extraWarnings];
    }

    return result;
  }
}
