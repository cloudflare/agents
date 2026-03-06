/**
 * Utility functions.
 */

import type { Files, WranglerConfig } from "./types";

/**
 * Detect entry point from wrangler config, package.json, or use defaults.
 * Priority: wrangler main > package.json exports/module/main > default paths
 */
export function detectEntryPoint(
  files: Files,
  wranglerConfig: WranglerConfig | undefined
): string | undefined {
  // First, check wrangler config main field
  if (wranglerConfig?.main) {
    return normalizeEntryPath(wranglerConfig.main);
  }

  // Try to read package.json
  const packageJsonContent = files["package.json"];
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
    if (entry in files) {
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
