/**
 * Dynamic Worker Bundler
 *
 * Creates worker bundles from source files for Cloudflare's Worker Loader binding.
 */

import { bundleWithEsbuild } from "./bundler";
import { hasNodejsCompat, parseWranglerConfig } from "./config";
import { hasDependencies, installDependencies } from "./installer";
import { transformAndResolve } from "./transformer";
import type { CreateWorkerOptions, CreateWorkerResult } from "./types";
import { detectEntryPoint } from "./utils";
import { showExperimentalWarning } from "./experimental";

// Re-export types
export type {
  CreateWorkerOptions,
  CreateWorkerResult,
  Files,
  Modules,
  WranglerConfig
} from "./types";

// Re-export app bundler
export { createApp } from "./app";
export type { CreateAppOptions, CreateAppResult } from "./app";

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
    bundle = true,
    externals = [],
    target = "es2022",
    minify = false,
    sourcemap = false,
    registry
  } = options;

  // Always treat cloudflare:* modules as external (runtime-provided)
  externals = ["cloudflare:", ...externals];

  // Parse wrangler config for compatibility settings
  const wranglerConfig = parseWranglerConfig(files);
  const nodejsCompat = hasNodejsCompat(wranglerConfig);

  // Auto-install dependencies if package.json has dependencies
  const installWarnings: string[] = [];
  if (hasDependencies(files)) {
    const installResult = await installDependencies(
      files,
      registry ? { registry } : {}
    );
    files = installResult.files;
    installWarnings.push(...installResult.warnings);
  }

  // Detect entry point (priority: explicit option > wrangler main > package.json > defaults)
  const entryPoint =
    options.entryPoint ?? detectEntryPoint(files, wranglerConfig);

  if (!entryPoint) {
    throw new Error(
      "Could not determine entry point. Please specify entryPoint option."
    );
  }

  if (!(entryPoint in files)) {
    throw new Error(`Entry point "${entryPoint}" not found in files.`);
  }

  if (bundle) {
    // Try bundling with esbuild-wasm
    const result = await bundleWithEsbuild(
      files,
      entryPoint,
      externals,
      target,
      minify,
      sourcemap,
      nodejsCompat
    );

    // Add wrangler config if a config file was found
    if (wranglerConfig !== undefined) {
      result.wranglerConfig = wranglerConfig;
    }

    // Add install warnings to result
    if (installWarnings.length > 0) {
      result.warnings = [...(result.warnings ?? []), ...installWarnings];
    }

    return result;
  } else {
    // No bundling - transform files and resolve dependencies
    // Note: sourcemaps are not supported in transform mode (output mirrors input structure)
    const result = await transformAndResolve(files, entryPoint, externals);

    // Add wrangler config if a config file was found
    if (wranglerConfig !== undefined) {
      result.wranglerConfig = wranglerConfig;
    }

    // Add install warnings to result
    if (installWarnings.length > 0) {
      result.warnings = [...(result.warnings ?? []), ...installWarnings];
    }

    return result;
  }
}
