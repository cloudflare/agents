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
    retry: 3,
    include: ["src/legacy/tests/**/*.test.ts"],
    exclude: ["src/legacy/tests/**/*.browser.test.ts"]
  }
});
