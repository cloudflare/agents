/**
 * Utility functions.
 */

import type { WranglerConfig } from "./types";
import type { FileSystem } from "./file-system";

/**
 * Detect entry point from wrangler config, package.json, or use defaults.
 * Priority: wrangler main > package.json exports/module/main > default paths
 */
export function detectEntryPoint(
  files: FileSystem,
  wranglerConfig: WranglerConfig | undefined
): string | undefined {
  // First, check wrangler config main field
  if (wranglerConfig?.main) {
    return normalizeEntryPath(wranglerConfig.main);
  }

  // Try to read package.json
  const packageJsonContent = files.read("package.json");
  if (packageJsonContent) {
    try {
      const pkg = JSON.parse(packageJsonContent) as {
        main?: string;
        module?: string;
        exports?: Record<string, unknown> | string;
      };

      // Check exports field first
      if (pkg.exports) {
        if (typeof pkg.exports === "string") {
          return normalizeEntryPath(pkg.exports);
        }
        // Handle exports object - look for "." entry
        const dotExport = pkg.exports["."];
        if (dotExport) {
          if (typeof dotExport === "string") {
            return normalizeEntryPath(dotExport);
          }
          // Handle conditional exports
          if (typeof dotExport === "object" && dotExport !== null) {
            const exp = dotExport as Record<string, unknown>;
            const entry = exp["import"] ?? exp["default"] ?? exp["module"];
            if (typeof entry === "string") {
              return normalizeEntryPath(entry);
            }
          }
        }
      }

      // Check module field
      if (pkg.module) {
        return normalizeEntryPath(pkg.module);
      }

      // Check main field
      if (pkg.main) {
        return normalizeEntryPath(pkg.main);
      }
    } catch {
      // Invalid JSON, continue to defaults
    }
  }

  // Default entry points
  const defaultEntries = [
    "src/index.ts",
    "src/index.js",
    "src/index.mts",
    "src/index.mjs",
    "index.ts",
    "index.js",
    "src/worker.ts",
    "src/worker.js"
  ];

  for (const entry of defaultEntries) {
    if (files.read(entry) !== null) {
      return entry;
    }
  }

  return undefined;
}

function normalizeEntryPath(path: string): string {
  // Remove leading ./
  if (path.startsWith("./")) {
    return path.slice(2);
  }
  return path;
}

/**
 * Render the user-provided source files as a short, readable list for use in
 * "entry point not found" errors. Skips installed `node_modules/` files
 * (which can be tens of thousands of paths and drown out the actually
 * relevant signal — the files the user passed in) and truncates the tail.
 */
export function formatFileListForError(files: FileSystem, limit = 10): string {
  const all = files
    .list()
    .filter((p) => !p.startsWith("node_modules/"))
    .sort();
  if (all.length === 0) {
    return "(none — `files` is empty or only contains node_modules entries)";
  }
  const shown = all.slice(0, limit).join(", ");
  if (all.length <= limit) return shown;
  return `${shown}, … (+${all.length - limit} more)`;
}
