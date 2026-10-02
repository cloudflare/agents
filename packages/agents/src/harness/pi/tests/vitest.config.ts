import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { stripNodeModulesSourceMapReferences } from "../../../../../../scripts/vitest/strip-node-modules-source-map-references";
import { defineConfig } from "vitest/config";

const testsDir = import.meta.dirname;

export default defineConfig({
  plugins: [
    stripNodeModulesSourceMapReferences(),
    cloudflareTest({
      wrangler: { configPath: path.join(testsDir, "wrangler.jsonc") }
    })
  ],
  resolve: {
    // One copy of pi's module state for the harness and the tests.
    dedupe: ["@earendil-works/pi-ai", "@earendil-works/pi-durable"]
  },
  test: {
    name: "harness-pi",
    // harness.test.ts crashes objects with abortAllDurableObjects(), which
    // reaches every object in the runtime, including other files' objects.
    fileParallelism: false,
    include: [path.join(testsDir, "**/*.test.ts")],
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
