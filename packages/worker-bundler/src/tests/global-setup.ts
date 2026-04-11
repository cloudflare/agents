import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  bundleTypeScriptForWorkers,
  removeBundledTypeScript
} from "../../scripts/typescript-browser-bundle";
const require = createRequire(import.meta.url);
const wasmSrc = require.resolve("esbuild-wasm/esbuild.wasm");
const wasmDest = path.resolve(import.meta.dirname, "../esbuild.wasm");
const packageRoot = path.resolve(import.meta.dirname, "../..");

export async function setup() {
  await bundleTypeScriptForWorkers(packageRoot);

  if (!existsSync(wasmDest)) {
    copyFileSync(wasmSrc, wasmDest);
  }
}

export function teardown() {
  removeBundledTypeScript(packageRoot);

  if (existsSync(wasmDest)) {
    unlinkSync(wasmDest);
  }
}
