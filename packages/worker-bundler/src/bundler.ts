/**
 * esbuild-wasm bundling functionality.
 */

// Use the browser entry directly — the default "main" entry rejects
// wasmModule in Workers with nodejs_compat (it thinks it's Node.js).
import * as esbuild from "esbuild-wasm/lib/browser.js";

// @ts-expect-error - WASM module import
import esbuildWasm from "./esbuild.wasm";
import { resolveModule } from "./resolver";
import type { CreateWorkerResult, Files, Modules } from "./types";

/**
 * Bundle files using esbuild-wasm
 */
export async function bundleWithEsbuild(
  files: Files,
  entryPoint: string,
  externals: string[],
  target: string,
  minify: boolean,
  sourcemap: boolean,
  nodejsCompat: boolean
): Promise<CreateWorkerResult> {
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
        if (normalizedPath in files) {
          return { path: normalizedPath, namespace: "virtual" };
        }

        return { path: args.path, external: true };
      });

      // Load files from virtual file system
      build.onLoad({ filter: /.*/, namespace: "virtual" }, (args) => {
        const content = files[args.path];
        if (content === undefined) {
          return { errors: [{ text: `File not found: ${args.path}` }] };
        }

        const loader = getLoader(args.path);
        // Set resolveDir so relative imports within this file resolve correctly
        const lastSlash = args.path.lastIndexOf("/");
        const resolveDir = lastSlash >= 0 ? args.path.slice(0, lastSlash) : "";
        return { contents: content, loader, resolveDir };
      });
    }
  };

  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    format: "esm",
    platform: nodejsCompat ? "node" : "browser",
    target,
    minify,
    sourcemap: sourcemap ? "inline" : false,
    plugins: [virtualFsPlugin],
    outfile: "bundle.js"
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
  files: Files
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
  if (resolved in files) {
    return resolved;
  }

  // Try adding extensions
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"];
  for (const ext of extensions) {
    if (resolved + ext in files) {
      return resolved + ext;
    }
  }

  // Try index files
  for (const ext of extensions) {
    const indexPath = `${resolved}/index${ext}`;
    if (indexPath in files) {
      return indexPath;
    }
  }

  return undefined;
}

function getLoader(path: string): esbuild.Loader {
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
