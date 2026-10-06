/**
 * Think's workers suite, run against the harness-backed Think.
 *
 * Same tests, same worker, same agents. The only difference is that a
 * `../think` import made from inside `src/tests` resolves to
 * `src/harness/compat.ts`, which is the real module with `Think` swapped
 * for `src/harness/think.ts`. `pnpm test:harness` runs this config and
 * records the score in `harness-compat.md`.
 */
import path from "node:path";
import { mergeConfig } from "vitest/config";
import base from "./vitest.config";

const testsDir = import.meta.dirname;
const realThink = path.join(testsDir, "..", "think");
const compatThink = path.join(testsDir, "..", "harness", "compat.ts");

export default mergeConfig(base, {
  plugins: [
    {
      name: "think-harness-compat",
      enforce: "pre" as const,
      resolveId(source: string, importer: string | undefined) {
        if (!importer || !source.startsWith(".")) return null;
        const from = importer.split("?")[0];
        if (!from.startsWith(testsDir + path.sep)) return null;
        const target = path
          .resolve(path.dirname(from), source)
          .replace(/\.ts$/, "");
        return target === realThink ? compatThink : null;
      }
    }
  ],
  test: {
    name: "think-harness-compat",
    // The score is what passes on the first try.
    retry: 0
  }
});
