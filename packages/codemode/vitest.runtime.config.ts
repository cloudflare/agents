import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { stripNodeModulesSourceMapReferences } from "../../scripts/vitest/strip-node-modules-source-map-references";
import { defineConfig } from "vitest/config";

// Legacy durable-runtime e2e tests: a real DO host spawns the CodemodeRuntime facet
// and runs code in a real sandbox. Kept in its own project because it needs a
// wrangler config with Durable Object bindings (the default src/tests config
// has none).
export default defineConfig({
  plugins: [
    stripNodeModulesSourceMapReferences(),
    cloudflareTest({
      wrangler: { configPath: "./src/legacy/runtime-tests/wrangler.jsonc" }
    })
  ],
  test: {
    name: "runtime",
    retry: 3,
    include: ["src/legacy/runtime-tests/**/*.test.ts"]
  }
});
