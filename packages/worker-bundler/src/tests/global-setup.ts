import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const wasmSrc = require.resolve("esbuild-wasm/esbuild.wasm");
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
