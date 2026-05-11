import { readFile } from "node:fs/promises";
import type { Plugin } from "vite";

const sourceMapCommentRE =
  /(?:\/\/# sourceMappingURL=.*|\/\*# sourceMappingURL=.*?\*\/)\s*$/s;

/**
 * Some published dependencies include source map references without publishing
 * the original source files. Vite warns when it tries to hydrate those maps,
 * which makes test output noisy without improving debuggability.
 */
export function stripNodeModulesSourceMapReferences(): Plugin {
  return {
    name: "strip-node-modules-source-map-references",
    enforce: "pre",
    async load(id) {
      const file = id.split("?", 1)[0];
      if (!file.includes("/node_modules/") || !/\.[cm]?js$/.test(file)) {
        return null;
      }

      const code = await readFile(file, "utf8").catch(() => null);
      if (!code?.includes("sourceMappingURL=")) {
        return null;
      }

      return {
        code: code.replace(sourceMapCommentRE, ""),
        map: null
      };
    }
  };
}
