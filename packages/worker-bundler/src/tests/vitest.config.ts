import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { stripNodeModulesSourceMapReferences } from "../../../../scripts/vitest/strip-node-modules-source-map-references";
import { defineConfig } from "vitest/config";

const testsDir = import.meta.dirname;

export default defineConfig({
  plugins: [
    stripNodeModulesSourceMapReferences(),
    cloudflareTest({
      wrangler: { configPath: path.join(testsDir, "wrangler.jsonc") }
    })
  ],
  test: {
    name: "workers",
    include: [path.join(testsDir, "**/*.test.ts")],
    // Copies esbuild.wasm into src/ before tests, removes after
    globalSetup: [path.join(testsDir, "global-setup.ts")]
  }
});
