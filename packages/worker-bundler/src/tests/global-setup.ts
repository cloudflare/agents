import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const wasmSrc = path.join(repoRoot, "node_modules/esbuild-wasm/esbuild.wasm");
const wasmDest = path.resolve(import.meta.dirname, "../esbuild.wasm");

export function setup() {
  if (!existsSync(wasmDest)) {
    copyFileSync(wasmSrc, wasmDest);
  }
}

export function teardown() {
  if (existsSync(wasmDest)) {
    unlinkSync(wasmDest);
  }
}
