/**
 * esbuild-wasm bundling functionality.
 */

// Use the browser entry directly — the default "main" entry rejects
// wasmModule in Workers with nodejs_compat (it thinks it's Node.js).
import * as esbuild from "esbuild-wasm/lib/browser.js";

// @ts-expect-error - WASM module import
import esbuildWasm from "./esbuild.wasm";
import { resolveModule } from "./resolver";
import type { FileSystem } from "./file-system";
import type {
  BundlerLoader,
  CreateWorkerResult,
  JsxMode,
  Modules
} from "./types";

/**
 * Build a single warning string listing the bundler-only options the caller
 * set together with `bundle: false`. Returns `null` if none were set.
 *
 * `transformAndResolve` is sucrase + naïve module resolution — it cannot apply
 * `define` substitution, custom `loader` overrides, package-export `conditions`,
 * or esbuild plugins. Silently ignoring these would produce subtly wrong output
 * (e.g. `__DEV__` left as a free identifier in the emitted bundle).
 */
export function bundlerOnlyOptionsWarning(opts: {
  jsx?: unknown;
  jsxImportSource?: unknown;
  define?: unknown;
  loader?: unknown;
  conditions?: unknown;
  plugins?: unknown;
}): string | null {
  const set: string[] = [];
  if (opts.jsx !== undefined) set.push("jsx");
  if (opts.jsxImportSource !== undefined) set.push("jsxImportSource");
  if (opts.define !== undefined) set.push("define");
  if (opts.loader !== undefined) set.push("loader");
  if (opts.conditions !== undefined) set.push("conditions");
  if (opts.plugins !== undefined) {
    set.push("__dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired");
  }
  if (set.length === 0) return null;
  return `${set.join(", ")} ${set.length === 1 ? "is" : "are"} ignored when \`bundle: false\` (transform-only mode does not run esbuild). Set \`bundle: true\` (the default) to apply them.`;
}

/**
 * Internal options for bundleWithEsbuild. Kept as an object (rather than a
 * long positional list) so new bundler knobs can be added without churning
 * every call site.
 */
export interface BundleOptions {
  files: FileSystem;
  entryPoint: string;
  externals: string[];
  target: string;
  minify: boolean;
  sourcemap: boolean;
  nodejsCompat: boolean;
  jsx?: JsxMode;
  jsxImportSource?: string;
  define?: Record<string, string>;
  loader?: Record<string, BundlerLoader>;
  conditions?: string[];
  /** Extra esbuild plugins to run BEFORE the internal virtual-fs plugin. */
  plugins?: unknown[];
}

/**
 * Bundle files using esbuild-wasm
 */
export async function bundleWithEsbuild(
  options: BundleOptions
): Promise<CreateWorkerResult> {
  const {
    files,
    entryPoint,
    externals,
    target,
    minify,
    sourcemap,
    nodejsCompat,
    jsx,
    jsxImportSource,
    define,
    loader: loaderOverrides,
    conditions,
    plugins: extraPlugins = []
  } = options;
  // Ensure esbuild is initialized (happens lazily on first use)
  await initializeEsbuild();

  // Create a virtual file system plugin for esbuild
  const virtualFsPlugin: esbuild.Plugin = {
    name: "virtual-fs",
    setup(build) {
      // Resolve all paths to our virtual file system
      build.onResolve({ filter: /.*/ }, (args) => {
        // Handle entry point - it's passed directly without ./ prefix
        if (args.kind === "entry-point") {
          return { path: args.path, namespace: "virtual" };
        }

        // Handle relative imports
        if (args.path.startsWith(".")) {
          const resolved = resolveRelativePath(
            args.resolveDir,
            args.path,
            files
          );
          if (resolved) {
            return { path: resolved, namespace: "virtual" };
          }
        }

        // Handle bare imports (npm packages)
        if (!args.path.startsWith("/") && !args.path.startsWith(".")) {
          // Check if it's in externals
          if (
            externals.includes(args.path) ||
            externals.some(
              (e) => args.path.startsWith(`${e}/`) || args.path.startsWith(e)
            )
          ) {
            return { path: args.path, external: true };
          }

          // Try to resolve from node_modules in virtual fs
          try {
            const result = resolveModule(args.path, { files });
            if (!result.external) {
              return { path: result.path, namespace: "virtual" };
            }
          } catch {
            // Resolution failed
          }

          // Mark as external (package not found in node_modules)
          return { path: args.path, external: true };
        }

        // Absolute paths in virtual fs
        const normalizedPath = args.path.startsWith("/")
          ? args.path.slice(1)
          : args.path;
        if (files.read(normalizedPath) !== null) {
          return { path: normalizedPath, namespace: "virtual" };
        }

        return { path: args.path, external: true };
      });

      // Load files from virtual file system
      build.onLoad({ filter: /.*/, namespace: "virtual" }, (args) => {
        const content = files.read(args.path);
        if (content === null) {
          return { errors: [{ text: `File not found: ${args.path}` }] };
        }

        const loader = getLoader(args.path, loaderOverrides);
        // Set resolveDir so relative imports within this file resolve correctly
        const lastSlash = args.path.lastIndexOf("/");
        const resolveDir = lastSlash >= 0 ? args.path.slice(0, lastSlash) : "";
        return { contents: content, loader, resolveDir };
      });
    }
  };

  // Validate user plugins eagerly: the public type is `unknown[]` (so the
  // .d.ts stays free of esbuild types), which means anything can flow in.
  // Without this, a bad value surfaces as an opaque crash from inside esbuild's
  // own plugin machinery — point at the dangerous option name instead.
  for (let i = 0; i < extraPlugins.length; i++) {
    const p = extraPlugins[i] as
      | { name?: unknown; setup?: unknown }
      | null
      | undefined;
    if (
      !p ||
      typeof p !== "object" ||
      typeof p.name !== "string" ||
      typeof p.setup !== "function"
    ) {
      throw new TypeError(
        `__dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired[${i}] is not a valid esbuild plugin (expected an object with \`name: string\` and \`setup: (build) => void\`).`
      );
    }
  }

  // User plugins run BEFORE the internal virtual-fs plugin so they get first
  // crack at onResolve / onLoad (e.g. an RSC plugin claiming "server-function:*"
  // before virtual-fs tries to read it from disk). Don't reorder this without
  // thinking about it.
  const userPlugins = extraPlugins as esbuild.Plugin[];

  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    format: "esm",
    platform: nodejsCompat ? "node" : "browser",
    target,
    minify,
    sourcemap: sourcemap ? "inline" : false,
    plugins: [...userPlugins, virtualFsPlugin],
    outfile: "bundle.js",
    ...(jsx !== undefined ? { jsx } : {}),
    ...(jsxImportSource !== undefined ? { jsxImportSource } : {}),
    ...(define !== undefined ? { define } : {}),
    ...(conditions !== undefined ? { conditions } : {})
  });

  const output = result.outputFiles?.[0];
  if (!output) {
    throw new Error("No output generated from esbuild");
  }

  const modules: Modules = {
    "bundle.js": output.text
  };

  const warnings = result.warnings.map((w) => w.text);
  if (warnings.length > 0) {
    return { mainModule: "bundle.js", modules, warnings };
  }
  return { mainModule: "bundle.js", modules };
}

/**
 * Resolve a relative path against a directory within the virtual filesystem.
 */
function resolveRelativePath(
  resolveDir: string,
  relativePath: string,
  files: FileSystem
): string | undefined {
  // Normalize the resolve directory
  const dir = resolveDir.replace(/^\//, "");

  // Resolve the relative path
  const parts = dir ? dir.split("/") : [];
  const relParts = relativePath.split("/");

  for (const part of relParts) {
    if (part === "..") {
      parts.pop();
    } else if (part !== ".") {
      parts.push(part);
    }
  }

  const resolved = parts.join("/");

  // Try exact match
  if (files.read(resolved) !== null) {
    return resolved;
  }

  // Try adding extensions
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"];
  for (const ext of extensions) {
    if (files.read(resolved + ext) !== null) {
      return resolved + ext;
    }
  }

  // Try index files
  for (const ext of extensions) {
    const indexPath = `${resolved}/index${ext}`;
    if (files.read(indexPath) !== null) {
      return indexPath;
    }
  }

  return undefined;
}

function getLoader(
  path: string,
  overrides?: Record<string, BundlerLoader>
): esbuild.Loader {
  if (overrides) {
    // Match on the longest extension first so ".d.ts" wins over ".ts" if both
    // are configured.
    const matched = Object.keys(overrides)
      .filter((ext) => path.endsWith(ext))
      .sort((a, b) => b.length - a.length)[0];
    if (matched !== undefined) {
      return overrides[matched] as esbuild.Loader;
    }
  }
  if (path.endsWith(".ts") || path.endsWith(".mts")) return "ts";
  if (path.endsWith(".tsx")) return "tsx";
  if (path.endsWith(".jsx")) return "jsx";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".css")) return "css";
  return "js";
}

// Track esbuild initialization state
let esbuildInitialized = false;
let esbuildInitializePromise: Promise<void> | null = null;

/**
 * Initialize the esbuild bundler.
 * This is called automatically when needed.
 */
async function initializeEsbuild(): Promise<void> {
  // If already initialized, return immediately
  if (esbuildInitialized) return;

  // If initialization is in progress, wait for it
  if (esbuildInitializePromise) {
    return esbuildInitializePromise;
  }

  // Start initialization
  esbuildInitializePromise = (async () => {
    try {
      await esbuild.initialize({
        wasmModule: esbuildWasm,
        worker: false
      });

      esbuildInitialized = true;
    } catch (error) {
      // If initialization fails, esbuild may already be initialized
      if (
        error instanceof Error &&
        error.message.includes('Cannot call "initialize" more than once')
      ) {
        esbuildInitialized = true;
        return;
      }
      throw error;
    }
  })();

  try {
    await esbuildInitializePromise;
  } catch (error) {
    // Reset promise so caller can try again
    esbuildInitializePromise = null;
    throw error;
  }
}
