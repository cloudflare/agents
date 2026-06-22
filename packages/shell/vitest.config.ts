import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { stripNodeModulesSourceMapReferences } from "../../scripts/vitest/strip-node-modules-source-map-references";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    stripNodeModulesSourceMapReferences(),
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Forward the opt-in gate for the networked git-clone test into the
      // Workers pool (host `process.env` is not visible inside workerd). See
      // `src/tests/git.test.ts` — off unless `RUN_GIT_CLONE_E2E=1` is set.
      miniflare: {
        bindings: { RUN_GIT_CLONE_E2E: process.env.RUN_GIT_CLONE_E2E ?? "" }
      }
    })
  ],
  test: {
    name: "workers",
    retry: 3,
    include: ["src/tests/**/*.test.ts"]
  }
});
