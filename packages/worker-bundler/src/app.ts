/**
 * App bundler: builds a full-stack app (server Worker + client bundle + static assets)
 * for the Worker Loader binding.
 *
 * Assets are returned separately for the host to serve — they are NOT embedded
 * in the dynamic isolate. The caller uses handleAssetRequest() on the host side
 * and only forwards non-asset requests to the isolate.
 */

import { bundleWithEsbuild } from "./bundler";
import { hasNodejsCompat, parseWranglerConfig } from "./config";
import { hasDependencies, installDependencies } from "./installer";
import { transformAndResolve } from "./transformer";
import type { AssetConfig, AssetManifest } from "./asset-handler";
import { buildAssetManifest } from "./asset-handler";
import type { CreateWorkerResult, Files } from "./types";
import { detectEntryPoint } from "./utils";
import { showExperimentalWarning } from "./experimental";

/**
 * Options for createApp
 */
export interface CreateAppOptions {
  /**
   * Input files — keys are paths relative to project root, values are file contents.
   * Should include both server and client source files.
   */
  files: Files;

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
  let {
    files,
    bundle = true,
    externals = [],
    target = "es2022",
    minify = false,
    sourcemap = false,
    registry
  } = options;

  // Always treat cloudflare:* as external
  externals = ["cloudflare:", ...externals];

  // Parse wrangler config
  const wranglerConfig = parseWranglerConfig(files);
  const nodejsCompat = hasNodejsCompat(wranglerConfig);

  // Install npm dependencies if needed
  const installWarnings: string[] = [];
  if (hasDependencies(files)) {
    const installResult = await installDependencies(
      files,
      registry ? { registry } : {}
    );
    files = installResult.files;
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
    if (!(clientEntry in files)) {
      throw new Error(
        `Client entry point "${clientEntry}" not found in files.`
      );
    }

    const clientResult = await bundleWithEsbuild(
      files,
      clientEntry,
      externals,
      "es2022",
      minify,
      sourcemap,
      false
    );

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
  const serverEntry = options.server ?? detectEntryPoint(files, wranglerConfig);

  if (!serverEntry) {
    throw new Error(
      "Could not determine server entry point. Specify the 'server' option."
    );
  }

  if (!(serverEntry in files)) {
    throw new Error(`Server entry point "${serverEntry}" not found in files.`);
  }

  let serverResult: CreateWorkerResult;
  if (bundle) {
    serverResult = await bundleWithEsbuild(
      files,
      serverEntry,
      externals,
      target,
      minify,
      sourcemap,
      nodejsCompat
    );
  } else {
    serverResult = await transformAndResolve(files, serverEntry, externals);
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
