import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { stripNodeModulesSourceMapReferences } from "../../../../../../scripts/vitest/strip-node-modules-source-map-references";
import { defineConfig } from "vitest/config";

const testsDir = import.meta.dirname;

export default defineConfig({
  plugins: [
    {
      // effect's HTTP API docs page inlines a Scalar bundle Vite cannot
      // parse. OpenCode never serves that page here, so it loads as empty.
      name: "empty-http-api-scalar",
      enforce: "pre",
      load: (id) =>
        id.includes("/effect/dist/unstable/httpapi/internal/httpApiScalar.js")
          ? 'export const javascript = "";'
          : null
    },
    stripNodeModulesSourceMapReferences(),
    cloudflareTest({
      wrangler: { configPath: path.join(testsDir, "wrangler.jsonc") }
    })
  ],
  resolve: {
    dedupe: ["vitest"]
  },
  test: {
    name: "harness-opencode",
    // The lease tests let objects sit out their lease, and the full-turn
    // tests run OpenCode's own timers; one file at a time keeps them apart.
    fileParallelism: false,
    include: [path.join(testsDir, "**/*.test.ts")],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    teardownTimeout: 60_000
  }
});
