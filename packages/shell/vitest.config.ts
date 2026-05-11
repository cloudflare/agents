import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { stripNodeModulesSourceMapReferences } from "../../scripts/vitest/strip-node-modules-source-map-references";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    stripNodeModulesSourceMapReferences(),
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" }
    })
  ],
  test: {
    name: "workers",
    include: ["src/tests/**/*.test.ts"]
  }
});
