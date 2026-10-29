import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { stripNodeModulesSourceMapReferences } from "../../../../../../scripts/vitest/strip-node-modules-source-map-references";
import { defineConfig } from "vitest/config";

const testsDir = import.meta.dirname;

export default defineConfig({
  plugins: [
    {
      // effect ships the Scalar API reference UI as one script that vite's
      // import analysis cannot parse. OpenCode never serves it here.
      name: "empty-httpapi-scalar",
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
  test: {
    name: "harness-opencode",
    // harness.test.ts crashes objects with abortAllDurableObjects(), which
    // reaches every object in the runtime, including other files' objects.
    fileParallelism: false,
    include: [path.join(testsDir, "**/*.test.ts")],
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
