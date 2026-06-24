/**
 * Codemode Vite plugin — exports the CodemodeRuntime facet from the Worker
 * entry module so `createCodemodeRuntime()` can spawn it via `ctx.exports`.
 *
 * Usage in vite.config.ts:
 * ```ts
 * import codemode from "@cloudflare/codemode/vite";
 * export default { plugins: [codemode()] };
 * ```
 */
import { relative } from "node:path";
import type { Plugin } from "vite";

const RUNTIME_EXPORT =
  'export { CodemodeRuntime } from "@cloudflare/codemode";';

export default function codemodeVitePlugin(): Plugin {
  let projectRoot: string;

  return {
    name: "@cloudflare/codemode/vite",
    enforce: "pre" as const,

    configResolved(config) {
      projectRoot = config.root;
    },

    transform(code, id) {
      if (!isWorkerEntry(id, projectRoot)) return null;
      if (exportsCodemodeRuntime(code)) return null;

      return {
        code: `${code}\n\n// Auto-exported by @cloudflare/codemode/vite\n${RUNTIME_EXPORT}\n`,
        map: null
      };
    }
  };
}

function isWorkerEntry(id: string, root: string): boolean {
  const rel = relative(root, id).replace(/\\/g, "/");
  return /^src\/(server|index|worker)\.[tj]sx?$/.test(rel);
}

function exportsCodemodeRuntime(code: string): boolean {
  if (/\bexport\s+(?:class|function)\s+CodemodeRuntime\b/.test(code)) {
    return true;
  }
  if (/\bexport\s+(?:const|let|var)\s+CodemodeRuntime\b/.test(code)) {
    return true;
  }

  const namedExports = /\bexport\s+(?!type\b)\{([^}]*)\}/g;
  for (const match of code.matchAll(namedExports)) {
    for (const rawSpecifier of match[1].split(",")) {
      const specifier = rawSpecifier.trim();
      if (!specifier || specifier.startsWith("type ")) continue;

      const [local, exported] = specifier.split(/\s+as\s+/);
      const exportedName = (exported ?? local).trim();
      if (exportedName === "CodemodeRuntime") return true;
    }
  }

  return false;
}
