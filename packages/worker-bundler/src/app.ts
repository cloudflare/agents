/**
 * App bundler: builds a full-stack app (server Worker + client bundle + static assets)
 * for the Worker Loader binding.
 *
 * Assets are returned separately for the host to serve — they are NOT embedded
 * in the dynamic isolate. The caller uses handleAssetRequest() on the host side
 * and only forwards non-asset requests to the isolate.
 */

import { bundleWithEsbuild, bundlerOnlyOptionsWarning } from "./bundler";
import { hasNodejsCompat, parseWranglerConfig } from "./config";
import { hasDependencies, installDependencies } from "./installer";
import { transformAndResolve } from "./transformer";
import type { AssetConfig, AssetManifest } from "./asset-handler";
import { buildAssetManifest } from "./asset-handler";
import type {
  BundlerLoader,
  CreateWorkerResult,
  Files,
  JsxMode
} from "./types";
import {
  InMemoryFileSystem,
  isFileSystem,
  type FileSystem
} from "./file-system";
import { detectEntryPoint } from "./utils";
import { showExperimentalWarning } from "./experimental";

/**
 * Options for createApp
 */
export interface CreateAppOptions {
  /**
   * Input files — keys are paths relative to project root, values are file contents.
   * Accepts a plain object (which is wrapped in an InMemoryFileSystem automatically)
   * or any FileSystem implementation for custom storage backends.
   */
  files: Files | FileSystem;

  /**
   * Server entry point (the Worker fetch handler).
   * If not specified, detected from wrangler config / package.json / defaults.
   */
  server?: string;

  /**
   * Client entry point(s) to bundle for the browser.
   * These are bundled with esbuild targeting the browser.
   */
  client?: string | string[];

  /**
   * Static assets to serve as-is (pathname -> content).
   * Keys should be URL pathnames (e.g., "/favicon.ico", "/robots.txt").
   * These are NOT processed by the bundler.
   */
  assets?: Record<string, string | ArrayBuffer>;

  /**
   * Asset serving configuration.
   */
  assetConfig?: AssetConfig;

  /**
   * Whether to bundle server dependencies.
   * @default true
   */
  bundle?: boolean;

  /**
   * External modules that should not be bundled.
   */
  externals?: string[];

  /**
   * Target environment for server bundle.
   * @default 'es2022'
   */
  target?: string;

  /**
   * Whether to minify the output.
   * @default false
   */
  minify?: boolean;

  /**
   * Generate source maps.
   * @default false
   */
  sourcemap?: boolean;

  /**
   * npm registry URL for fetching packages.
   */
  registry?: string;

  /**
   * JSX transform mode passed to esbuild. Applied to both server and client
   * bundles.
   */
  jsx?: JsxMode;

  /**
   * Module to import the JSX runtime from when `jsx: "automatic"`.
   */
  jsxImportSource?: string;

  /**
   * Constant replacements applied at bundle time. Applied to both server and
   * client bundles.
   */
  define?: Record<string, string>;

  /**
   * Per-extension loader overrides. Applied to both server and client bundles.
   */
  loader?: Record<string, BundlerLoader>;

  /**
   * Package export conditions to honour during resolution.
   * Applied to both server and client bundles (the host can pass e.g.
   * `["worker", "browser"]` for the client, but most users want a single
   * shared set).
   */
  conditions?: string[];

  /**
   * Escape hatch for advanced users: extra esbuild plugins to run **before**
   * the bundler's internal virtual-filesystem plugin. Applied to both server
   * and client bundles.
   *
   * The deliberately unwieldy name is the API contract:
   *
   *   - This option is **not** covered by semver. It can change shape, be
   *     renamed, or be removed in any release.
   *   - The runtime ties you to esbuild. If this package switches bundlers
   *     (e.g. to rolldown), plugins authored against this API will break.
   *
   * Typed as `unknown[]` at the public boundary to keep `esbuild-wasm` types
   * out of the published `.d.ts`. Cast your plugin array to `unknown[]` when
   * passing it in. Each element is validated at runtime: it must be an object
   * with `name: string` and `setup: (build) => void`.
   *
   * On the server side, only applies when `bundle: true`; transform-only mode
   * surfaces a warning instead. Always applies to client bundles.
   */
  __dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired?: unknown[];
}

/**
 * Result from createApp
 */
export interface CreateAppResult extends CreateWorkerResult {
  /**
   * Combined assets (user-provided + client bundles) for host-side serving.
   * The host should use createMemoryStorage(assets) and handleAssetRequest()
   * to serve these before forwarding requests to the isolate.
   */
  assets: Record<string, string | ArrayBuffer>;

  /**
   * The asset manifest for runtime request handling.
   * Contains metadata (content types, ETags) for each asset.
   */
  assetManifest: AssetManifest;

  /**
   * The asset config for runtime request handling.
   */
  assetConfig?: AssetConfig;

  /**
   * Client bundle output paths (relative to asset root).
   */
  clientBundles?: string[];
}

/**
 * Creates a full-stack app bundle from source files.
 *
 * This function:
 * 1. Bundles client entry point(s) for the browser (if provided)
 * 2. Collects static assets and builds the asset manifest
 * 3. Bundles the server Worker
 * 4. Returns server modules (for the isolate) and assets (for host-side serving) separately
 *
 * How the output is mounted (module worker, DO class, facet) is the caller's concern.
 */
export async function createApp(
  options: CreateAppOptions
): Promise<CreateAppResult> {
  showExperimentalWarning("createApp");
  const {
    files,
    bundle = true,
    externals: rawExternals = [],
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

  const fileSystem: FileSystem = isFileSystem(files)
    ? files
    : new InMemoryFileSystem(files);

  // Always treat cloudflare:* as external
  const externals = ["cloudflare:", ...rawExternals];

  // Parse wrangler config
  const wranglerConfig = parseWranglerConfig(fileSystem);
  const nodejsCompat = hasNodejsCompat(wranglerConfig);

  // Install npm dependencies if needed
  const installWarnings: string[] = [];
  if (hasDependencies(fileSystem)) {
    const installResult = await installDependencies(
      fileSystem,
      registry ? { registry } : {}
    );
    installWarnings.push(...installResult.warnings);
  }

  // ── Step 1: Build client bundles ──────────────────────────────────
  const clientEntries = options.client
    ? Array.isArray(options.client)
      ? options.client
      : [options.client]
    : [];

  const clientOutputs: Record<string, string> = {};
  const clientBundles: string[] = [];

  for (const clientEntry of clientEntries) {
    if (fileSystem.read(clientEntry) === null) {
      throw new Error(
        `Client entry point "${clientEntry}" not found in files.`
      );
    }

    const clientResult = await bundleWithEsbuild({
      files: fileSystem,
      entryPoint: clientEntry,
      externals,
      target: "es2022",
      minify,
      sourcemap,
      nodejsCompat: false,
      jsx,
      jsxImportSource,
      define,
      loader,
      conditions,
      plugins
    });

    const bundleModule = clientResult.modules["bundle.js"];
    if (typeof bundleModule === "string") {
      const baseName = clientEntry
        .replace(/^src\//, "")
        .replace(/\.(tsx?|jsx?)$/, ".js");
      const outputPath = `/${baseName}`;
      clientOutputs[outputPath] = bundleModule;
      clientBundles.push(outputPath);
    }
  }

  // ── Step 2: Collect all assets ────────────────────────────────────
  const allAssets: Record<string, string | ArrayBuffer> = {};

  if (options.assets) {
    for (const [pathname, content] of Object.entries(options.assets)) {
      const normalizedPath = pathname.startsWith("/")
        ? pathname
        : `/${pathname}`;
      allAssets[normalizedPath] = content;
    }
  }

  for (const [pathname, content] of Object.entries(clientOutputs)) {
    allAssets[pathname] = content;
  }

  const assetManifest = await buildAssetManifest(allAssets);

  // ── Step 3: Build server Worker ───────────────────────────────────
  const serverEntry =
    options.server ?? detectEntryPoint(fileSystem, wranglerConfig);

  if (!serverEntry) {
    throw new Error(
      "Could not determine server entry point. Specify the 'server' option."
    );
  }

  if (fileSystem.read(serverEntry) === null) {
    throw new Error(`Server entry point "${serverEntry}" not found in files.`);
  }

  let serverResult: CreateWorkerResult;
  if (bundle) {
    serverResult = await bundleWithEsbuild({
      files: fileSystem,
      entryPoint: serverEntry,
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
  } else {
    // Transform-only mode never invokes esbuild, so any bundler-only options
    // are silently inactive — surface that as a warning the caller can see.
    serverResult = await transformAndResolve(
      fileSystem,
      serverEntry,
      externals
    );

    const bundlerOnly = bundlerOnlyOptionsWarning({
      jsx,
      jsxImportSource,
      define,
      loader,
      conditions,
      plugins
    });
    if (bundlerOnly) {
      serverResult.warnings = [...(serverResult.warnings ?? []), bundlerOnly];
    }
  }

  const result: CreateAppResult = {
    mainModule: serverResult.mainModule,
    modules: serverResult.modules,
    assets: allAssets,
    assetManifest,
    assetConfig: options.assetConfig,
    clientBundles: clientBundles.length > 0 ? clientBundles : undefined
  };

  if (wranglerConfig !== undefined) {
    result.wranglerConfig = wranglerConfig;
  }

  if (installWarnings.length > 0) {
    result.warnings = [...(serverResult.warnings ?? []), ...installWarnings];
  } else if (serverResult.warnings) {
    result.warnings = serverResult.warnings;
  }

  return result;
}
