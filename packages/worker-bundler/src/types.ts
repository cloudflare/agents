import type { FileSystem } from "./file-system";

/**
 * Input files for the bundler
 * Keys are file paths, values are file contents
 */
export type Files = Record<string, string>;

/**
 * Module format for Worker Loader binding
 */
export interface Module {
  js?: string;
  cjs?: string;
  text?: string;
  data?: ArrayBuffer;
  json?: object;
}

/**
 * Output modules for Worker Loader binding
 */
export type Modules = Record<string, string | Module>;

/**
 * Loader names supported for the `loader` option.
 *
 * Deliberately narrowed to the portable subset that every bundler in the
 * ecosystem (esbuild, rolldown, rspack, vite, webpack) can express:
 *
 *   - script flavours: `js`, `jsx`, `ts`, `tsx`, `json`, `css`
 *   - file content embedding: `text`, `binary`, `base64`, `dataurl`
 *
 * esbuild's `file` and `copy` loaders are intentionally NOT exposed: they
 * emit secondary output files that the bundler currently discards (only the
 * first output file is read). esbuild's `default` / `empty` / `local-css` /
 * `global-css` are also omitted because they are esbuild-internal control
 * flow, not portable concepts.
 *
 * Anything outside this set should go through
 * `__dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired` instead.
 */
export type BundlerLoader =
  | "js"
  | "jsx"
  | "ts"
  | "tsx"
  | "json"
  | "css"
  | "text"
  | "binary"
  | "base64"
  | "dataurl";

/**
 * JSX transform mode passed to esbuild.
 */
export type JsxMode = "transform" | "preserve" | "automatic";

/**
 * Options for createWorker
 */
export interface CreateWorkerOptions {
  /**
   * Input files - keys are paths relative to project root, values are file contents
   */
  files: Files | FileSystem;

  /**
   * Entry point file path (relative to project root)
   * If not specified, will try to determine from wrangler.toml main field,
   * then package.json, then default paths (src/index.ts, etc.)
   */
  entryPoint?: string;

  /**
   * Whether to bundle all dependencies into a single file
   * @default true
   */
  bundle?: boolean;

  /**
   * External modules that should not be bundled.
   * Note: `cloudflare:*` modules are always treated as external.
   */
  externals?: string[];

  /**
   * Target environment
   * @default 'es2022'
   */
  target?: string;

  /**
   * Whether to minify the output
   * @default false
   */
  minify?: boolean;

  /**
   * Generate inline source maps for better debugging and error stack traces.
   * Only applies when `bundle: true`. Has no effect in transform-only mode
   * since the output closely mirrors the input structure.
   * @default false
   */
  sourcemap?: boolean;

  /**
   * npm registry URL for fetching packages.
   * @default 'https://registry.npmjs.org'
   */
  registry?: string;

  /**
   * JSX transform mode passed to esbuild.
   * `"automatic"` enables the new JSX runtime (no need to import React).
   *
   * Only applies when `bundle: true` (the default). In transform-only mode this
   * option is ignored and a warning is added to the result's `warnings` array.
   */
  jsx?: JsxMode;

  /**
   * Module to import the JSX runtime from when `jsx: "automatic"`.
   * @example "react", "preact", "@emotion/react"
   *
   * Only applies when `bundle: true`.
   */
  jsxImportSource?: string;

  /**
   * Constant replacements applied at bundle time. Each key is replaced with the
   * corresponding value (which must be a JSON-serialisable JavaScript expression).
   * @example { "process.env.NODE_ENV": '"production"', "__DEV__": "false" }
   *
   * Only applies when `bundle: true`. In transform-only mode this option is
   * ignored and a warning is added to the result's `warnings` array.
   */
  define?: Record<string, string>;

  /**
   * Per-extension loader overrides. Extensions are matched on file paths
   * (including the leading dot, e.g. `".svg"`). Built-in handling for
   * `.ts`/`.tsx`/`.js`/`.jsx`/`.json`/`.css` is preserved unless overridden here.
   *
   * Only applies when `bundle: true`.
   */
  loader?: Record<string, BundlerLoader>;

  /**
   * Package export conditions to honour during resolution
   * (e.g. `["workerd", "worker", "browser"]`).
   * Order matters — earlier conditions take precedence.
   *
   * Only applies when `bundle: true`.
   */
  conditions?: string[];

  /**
   * Escape hatch for advanced users: extra esbuild plugins to run **before**
   * the bundler's internal virtual-filesystem plugin.
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
   * Only applies when `bundle: true`. In transform-only mode this option is
   * ignored and a warning is added to the result's `warnings` array.
   */
  __dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired?: unknown[];
}

/**
 * Parsed wrangler configuration relevant to Worker Loader
 */
export interface WranglerConfig {
  main?: string;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
}

/**
 * Result from createWorker
 */
export interface CreateWorkerResult {
  /**
   * The main module entry point path
   */
  mainModule: string;

  /**
   * All modules in the bundle
   */
  modules: Modules;

  /**
   * Parsed wrangler configuration (from wrangler.toml/json/jsonc).
   */
  wranglerConfig?: WranglerConfig;

  /**
   * Any warnings generated during bundling
   */
  warnings?: string[];
}
