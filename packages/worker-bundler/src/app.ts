/**
 * App bundler: builds a full-stack app (server Worker + client bundle + static assets)
 * for the Worker Loader binding.
 */

import { bundleWithEsbuild } from "./bundler";
import { hasNodejsCompat, parseWranglerConfig } from "./config";
import { hasDependencies, installDependencies } from "./installer";
import { transformAndResolve } from "./transformer";
import type { AssetConfig, AssetManifest } from "./asset-handler";
import { buildAssetManifest } from "./asset-handler";
import type { CreateWorkerResult, Files, Modules } from "./types";
import { detectEntryPoint } from "./utils";
import { ASSET_RUNTIME_CODE } from "./_asset-runtime-code";

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

  /**
   * Generate a Durable Object class wrapper instead of a module worker.
   * When set, the output exports a named class that can be used with
   * ctx.facets.get() / getDurableObjectClass() for persistent storage.
   *
   * If the user's server exports a DurableObject subclass (default export),
   * the wrapper extends it. Otherwise, it wraps the fetch handler in a DO.
   *
   * Pass `true` for className "App", or an object with a custom className.
   */
  durableObject?: { className?: string } | boolean;
}

/**
 * Result from createApp
 */
export interface CreateAppResult extends CreateWorkerResult {
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

  /**
   * The Durable Object class name exported by the wrapper.
   * Only set when `durableObject` option was used.
   * Use with `worker.getDurableObjectClass(className)` and `ctx.facets.get()`.
   */
  durableObjectClassName?: string;
}

/**
 * Creates a full-stack app bundle from source files.
 *
 * This function:
 * 1. Bundles client entry point(s) for the browser (if provided)
 * 2. Collects static assets
 * 3. Bundles the server Worker
 * 4. Generates a server wrapper that serves assets and falls through to user code
 * 5. Returns everything ready for the Worker Loader
 */
export async function createApp(
  options: CreateAppOptions
): Promise<CreateAppResult> {
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

    // Bundle the client with esbuild targeting browser
    const clientResult = await bundleWithEsbuild(
      files,
      clientEntry,
      externals,
      "es2022", // Browser target
      minify,
      sourcemap,
      false // No nodejs_compat for client
    );

    // Extract the bundled output
    const bundleModule = clientResult.modules["bundle.js"];
    if (typeof bundleModule === "string") {
      // Derive output name from entry
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

  // Add user-provided static assets
  if (options.assets) {
    for (const [pathname, content] of Object.entries(options.assets)) {
      const normalizedPath = pathname.startsWith("/")
        ? pathname
        : `/${pathname}`;
      allAssets[normalizedPath] = content;
    }
  }

  // Add client bundle outputs
  for (const [pathname, content] of Object.entries(clientOutputs)) {
    allAssets[pathname] = content;
  }

  // Build the asset manifest (metadata only — no content stored)
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

  // Build the server
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

  // ── Step 4: Build combined modules ────────────────────────────────
  const modules: Modules = { ...serverResult.modules };

  // Add assets as text or binary modules under __assets/ prefix
  for (const [pathname, content] of Object.entries(allAssets)) {
    const moduleName = `__assets${pathname}`;
    if (typeof content === "string") {
      modules[moduleName] = { text: content };
    } else {
      modules[moduleName] = { data: content };
    }
  }

  // Add the asset manifest as a JSON module
  const manifestJson: Record<
    string,
    { contentType: string | undefined; etag: string }
  > = {};
  for (const [pathname, meta] of assetManifest) {
    manifestJson[pathname] = {
      contentType: meta.contentType,
      etag: meta.etag
    };
  }
  modules["__asset-manifest.json"] = { json: manifestJson };

  // ── Step 5: Generate the app wrapper ──────────────────────────────
  const assetPathnames = [...assetManifest.keys()];

  // Resolve DO class name if durableObject option is set
  const doOption = options.durableObject;
  const doClassName = doOption
    ? typeof doOption === "object" && doOption.className
      ? doOption.className
      : "App"
    : undefined;

  const wrapperCode = doClassName
    ? generateDOAppWrapper(
        serverResult.mainModule,
        assetPathnames,
        doClassName,
        options.assetConfig
      )
    : generateAppWrapper(
        serverResult.mainModule,
        assetPathnames,
        options.assetConfig
      );
  modules["__app-wrapper.js"] = wrapperCode;

  // Include the pre-built asset handler runtime module
  modules["__asset-runtime.js"] = ASSET_RUNTIME_CODE;

  const result: CreateAppResult = {
    mainModule: "__app-wrapper.js",
    modules,
    assetManifest,
    assetConfig: options.assetConfig,
    clientBundles: clientBundles.length > 0 ? clientBundles : undefined,
    durableObjectClassName: doClassName
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

/**
 * Generate the asset imports + initialization preamble shared by both wrappers.
 * Returns the import statements and the initialization code that creates
 * the manifest Map, memory storage, and ASSET_CONFIG for handleAssetRequest.
 */
function generateAssetPreamble(
  assetPathnames: string[],
  assetConfig?: AssetConfig
): { importsBlock: string; initBlock: string } {
  const configJson = JSON.stringify(assetConfig ?? {});

  const imports: string[] = [];
  const mapEntries: string[] = [];
  for (let i = 0; i < assetPathnames.length; i++) {
    const pathname = assetPathnames[i];
    const moduleName = `__assets${pathname}`;
    const varName = `__asset_${i}`;
    imports.push(`import ${varName} from "./${moduleName}";`);
    mapEntries.push(`  ${JSON.stringify(pathname)}: ${varName}`);
  }

  const importsBlock = [
    'import { handleAssetRequest, createMemoryStorage } from "./__asset-runtime.js";',
    'import manifestJson from "./__asset-manifest.json";',
    ...imports
  ].join("\n");

  const contentMapBlock = `const ASSET_CONTENT = {\n${mapEntries.join(",\n")}\n};`;

  const initBlock = `
const ASSET_CONFIG = ${configJson};
${contentMapBlock}

// Build manifest Map and storage at module init time
const manifest = new Map(Object.entries(manifestJson));
const storage = createMemoryStorage(ASSET_CONTENT);
`.trimStart();

  return { importsBlock, initBlock };
}

/**
 * Generate the app wrapper module source.
 * This Worker serves assets first, then falls through to the user's server.
 *
 * Uses the pre-built __asset-runtime.js module for full asset handling
 * (all HTML modes, redirects, custom headers, ETag caching, etc.)
 */
function generateAppWrapper(
  userServerModule: string,
  assetPathnames: string[],
  assetConfig?: AssetConfig
): string {
  const { importsBlock, initBlock } = generateAssetPreamble(
    assetPathnames,
    assetConfig
  );

  return `
import userWorker from "./${userServerModule}";
${importsBlock}

${initBlock}
export default {
  async fetch(request, env, ctx) {
    const assetResponse = await handleAssetRequest(request, manifest, storage, ASSET_CONFIG);
    if (assetResponse) return assetResponse;

    // Fall through to user's Worker
    if (typeof userWorker === "object" && userWorker !== null && typeof userWorker.fetch === "function") {
      return userWorker.fetch(request, env, ctx);
    }
    if (typeof userWorker === "function") {
      return userWorker(request, env, ctx);
    }

    return new Response("Not Found", { status: 404 });
  }
};
`.trim();
}

/**
 * Generate a Durable Object class wrapper module source.
 * Exports a named class that serves assets first, then delegates to the
 * user's server code. If the user's default export is a class (DurableObject
 * subclass), the wrapper extends it so `this.ctx.storage` works naturally.
 * Otherwise, it wraps the fetch handler in a DurableObject.
 *
 * Uses the pre-built __asset-runtime.js module for full asset handling.
 */
function generateDOAppWrapper(
  userServerModule: string,
  assetPathnames: string[],
  className: string,
  assetConfig?: AssetConfig
): string {
  const { importsBlock, initBlock } = generateAssetPreamble(
    assetPathnames,
    assetConfig
  );

  return `
import { DurableObject } from "cloudflare:workers";
import userExport from "./${userServerModule}";
${importsBlock}

${initBlock}
// Determine base class: if user exported a DurableObject subclass, extend it
// so this.ctx.storage works naturally. Regular functions and plain objects are
// wrapped in a minimal DurableObject that delegates fetch().
// NOTE: This check uses prototype presence — regular (non-arrow) functions also
// have .prototype, but the system prompt instructs class exports for DO mode.
const BaseClass = (typeof userExport === "function" && userExport.prototype)
  ? userExport
  : class extends DurableObject {
      async fetch(request) {
        if (typeof userExport === "object" && userExport !== null && typeof userExport.fetch === "function") {
          return userExport.fetch(request, this.env, this.ctx);
        }
        return new Response("Not Found", { status: 404 });
      }
    };

export class ${className} extends BaseClass {
  async fetch(request) {
    const assetResponse = await handleAssetRequest(request, manifest, storage, ASSET_CONFIG);
    if (assetResponse) return assetResponse;
    return super.fetch(request);
  }
}
`.trim();
}
