/**
 * Codemode Vite plugin — handles `type: "connectors"` import attributes.
 *
 * Usage in vite.config.ts:
 * ```ts
 * import codemode from "@cloudflare/codemode/vite";
 * export default { plugins: [codemode()] };
 * ```
 *
 * Then import a directory of *.codemode.ts files:
 * ```ts
 * import connectors from "./connectors" with { type: "connectors" };
 * // pass connectors to createCodemodeRuntime({ ctx, executor, connectors })
 * ```
 *
 * Or import a single connector file:
 * ```ts
 * import connectors from "./github.codemode" with { type: "connectors" };
 * ```
 *
 * The plugin:
 * 1. Discovers *.codemode.{ts,js} files in the referenced directory
 * 2. Generates a module that re-exports each connector class
 * 3. Auto-exports connector classes from the worker entry for ctx.exports access
 */
import { resolve, dirname, relative } from "node:path";
import { readdirSync, statSync } from "node:fs";
import type { Plugin } from "vite";

const CODEMODE_PATTERN = /\.codemode\.[tj]sx?$/;
const VIRTUAL_PREFIX = "\0codemode-connectors:";
const PUBLIC_PREFIX = "__codemode_connectors__:";

export default function codemodeVitePlugin(): Plugin {
  let projectRoot: string;

  // Rewrites `from "./x" with { type: "connectors" }` → virtual module ref.
  // Also appends re-exports to the worker entry so connectors land in ctx.exports.
  function transformCode(
    code: string,
    id: string
  ): { code: string; map: null } | null {
    let result = code;
    let changed = false;

    // 1. Rewrite `with { type: "connectors" }` imports
    if (
      code.includes('type: "connectors"') ||
      code.includes("type: 'connectors'")
    ) {
      const next = code.replace(
        /from\s+(["'])([^"']+)\1\s+with\s+\{\s*type\s*:\s*(["'])connectors\3\s*\}/g,
        (_match, quote: string, source: string) => {
          const resolved = resolve(dirname(id), source);
          return `from ${quote}${PUBLIC_PREFIX}${encodeURIComponent(resolved)}${quote}`;
        }
      );
      if (next !== code) {
        result = next;
        changed = true;
      }
    }

    // 2. Append codemode exports to the worker entry
    if (isWorkerEntry(id, projectRoot)) {
      const srcDir = resolve(projectRoot, "src");
      const files = findCodemodeFiles(srcDir);
      const lines: string[] = [];

      // Auto-export CodemodeRuntime for facet spawning
      lines.push('export { CodemodeRuntime } from "@cloudflare/codemode";');

      // Auto-export connector classes from *.codemode.ts files
      for (const file of files) {
        lines.push(`export * from ${JSON.stringify(file)};`);
      }

      result = `${result}\n\n// Auto-exported by @cloudflare/codemode/vite\n${lines.join("\n")}\n`;
      changed = true;
    }

    return changed ? { code: result, map: null } : null;
  }

  return {
    name: "@cloudflare/codemode/vite",
    enforce: "pre" as const,

    configResolved(config) {
      projectRoot = config.root;
    },

    transform(code, id) {
      return transformCode(code, id);
    },

    resolveId(source, importer, options) {
      if (source.startsWith(PUBLIC_PREFIX)) {
        return `${VIRTUAL_PREFIX}${decodeURIComponent(source.slice(PUBLIC_PREFIX.length))}`;
      }

      const attributes = (options as { attributes?: Record<string, string> })
        .attributes;
      if (attributes?.type !== "connectors") return null;
      if (!importer) return null;
      const resolved = resolve(dirname(importer), source);
      return `${VIRTUAL_PREFIX}${resolved}`;
    },

    load(id) {
      if (!id.startsWith(VIRTUAL_PREFIX)) return null;
      const target = id.slice(VIRTUAL_PREFIX.length);

      const files = findCodemodeFiles(target);
      if (files.length === 0) {
        return "export default [];\n";
      }

      for (const file of files) {
        this.addWatchFile(file);
      }
      const stat = statSync(target, { throwIfNoEntry: false });
      if (stat?.isDirectory()) {
        this.addWatchFile(target);
      }

      // Re-export all connector classes from discovered files
      const lines: string[] = [];
      for (const file of files) {
        lines.push(`export * from ${JSON.stringify(file)};`);
      }

      return lines.join("\n") + "\n";
    }
  };
}

function isWorkerEntry(id: string, root: string): boolean {
  const rel = relative(root, id).replace(/\\/g, "/");
  return /^src\/(server|index|worker)\.[tj]sx?$/.test(rel);
}

function findCodemodeFiles(target: string): string[] {
  let stat = statSync(target, { throwIfNoEntry: false });

  // Try adding extensions if the target doesn't exist as-is
  if (!stat) {
    for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
      const withExt = target + ext;
      const extStat = statSync(withExt, { throwIfNoEntry: false });
      if (extStat?.isFile()) {
        return [withExt];
      }
    }
    return [];
  }

  if (stat.isFile() && CODEMODE_PATTERN.test(target)) {
    return [target];
  }

  if (!stat.isDirectory()) return [];
  const results: string[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (
        entry.isDirectory() &&
        entry.name !== "node_modules" &&
        entry.name !== "dist"
      ) {
        walk(full);
      } else if (entry.isFile() && CODEMODE_PATTERN.test(entry.name)) {
        results.push(full);
      }
    }
  }

  walk(target);
  return results;
}
