import { build } from "esbuild";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// `typescript`'s published entry is Node/CJS-oriented and was crashing when we
// imported it inside Workers with node-compatibility enabled due to ESM/CJS issues.
// This helper builds a temporary browser-targeted ESM bundle that `src/typecheck.ts`
// can safely import in both runtime and worker-test environments.

export function getTypeScriptBrowserBundlePath(packageRoot: string): string {
  return path.join(packageRoot, "src/vendor/typescript.browser.js");
}

export async function bundleTypeScriptForWorkers(
  packageRoot: string
): Promise<string> {
  const require = createRequire(path.join(packageRoot, "package.json"));
  const outputPath = getTypeScriptBrowserBundlePath(packageRoot);

  mkdirSync(path.dirname(outputPath), { recursive: true });

  await build({
    bundle: true,
    define: {
      "process.browser": "true"
    },
    entryPoints: [require.resolve("typescript/lib/typescript.js")],
    format: "esm",
    legalComments: "eof",
    minify: true,
    outfile: outputPath,
    platform: "browser",
    target: ["es2022"]
  });

  return outputPath;
}

export function removeBundledTypeScript(packageRoot: string): void {
  const outputPath = getTypeScriptBrowserBundlePath(packageRoot);

  if (existsSync(outputPath)) {
    rmSync(outputPath);
  }
}
