import { copyFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsdown";
import {
  bundleTypeScriptForWorkers,
  removeBundledTypeScript
} from "./typescript-browser-bundle";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");

async function main() {
  await bundleTypeScriptForWorkers(packageRoot);

  try {
    await build({
      clean: true,
      dts: true,
      entry: ["src/index.ts", "src/typescript.ts"],
      deps: {
        skipNodeModulesBundle: true,
        neverBundle: ["cloudflare:workers", "./esbuild.wasm"]
      },
      format: "esm",
      sourcemap: true,
      fixedExtension: false
    });

    // Copy esbuild.wasm from esbuild-wasm package into dist/
    const possiblePaths = [
      join(packageRoot, "node_modules/esbuild-wasm/esbuild.wasm"),
      join(packageRoot, "../../node_modules/esbuild-wasm/esbuild.wasm")
    ];

    let wasmSource: string | null = null;
    for (const p of possiblePaths) {
      if (existsSync(p)) {
        wasmSource = p;
        break;
      }
    }

    if (!wasmSource) {
      throw new Error("Could not find esbuild.wasm!");
    }

    const wasmDest = join(packageRoot, "dist/esbuild.wasm");
    copyFileSync(wasmSource, wasmDest);
    console.log("Copied esbuild.wasm to dist/");

    // then run oxfmt on the generated .d.ts files
    execSync("oxfmt --write ./dist/*.d.ts");
  } finally {
    removeBundledTypeScript(packageRoot);
  }
}

main().catch((err) => {
  // Build failures should fail
  console.error(err);
  process.exit(1);
});
