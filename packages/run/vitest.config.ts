import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { stripNodeModulesSourceMapReferences } from "../../scripts/vitest/strip-node-modules-source-map-references";
import { configDefaults, defineConfig } from "vitest/config";
import { dynamicWorkerSourcePlugin } from "./scripts/dynamic-worker-source-plugin";

export default defineConfig({
  plugins: [
    dynamicWorkerSourcePlugin(),
    stripNodeModulesSourceMapReferences(),
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" }
    })
  ],
  test: {
    name: "workers",
    retry: 3,
    include: ["src/**/*.test.ts"],
    // The deployed suite runs only via its own opt-in config; it deploys
    // real Workers and cannot run under the workers pool.
    exclude: [...configDefaults.exclude, "src/e2e-tests/**"]
  }
});
