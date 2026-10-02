import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { stripNodeModulesSourceMapReferences } from "../../../../../../scripts/vitest/strip-node-modules-source-map-references";
import { defineConfig } from "vitest/config";
import { CRASH_REASON } from "./crash";

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
    include: [path.join(testsDir, "**/*.test.ts")],
    // Also set in the root config, which is the one Vitest reads when this
    // runs as a project; this one covers running the config on its own.
    onUnhandledError: (error) => error.message !== CRASH_REASON,
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
