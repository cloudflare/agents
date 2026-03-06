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
 * Options for createWorker
 */
export interface CreateWorkerOptions {
  /**
   * Input files - keys are paths relative to project root, values are file contents
   */
  files: Files;

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
