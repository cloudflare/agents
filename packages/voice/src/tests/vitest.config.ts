import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { stripNodeModulesSourceMapReferences } from "../../../../scripts/vitest/strip-node-modules-source-map-references";
import { defineConfig } from "vitest/config";

const testsDir = import.meta.dirname;

export default defineConfig({
  plugins: [
    stripNodeModulesSourceMapReferences(),
    cloudflareTest({
      wrangler: {
        configPath: path.join(testsDir, "wrangler.jsonc")
      }
    })
  ],
  test: {
    name: "voice-workers",
    include: [path.join(testsDir, "**/*.test.ts")],
    exclude: [
      // SFU integration tests need real API credentials via process.env.
      // Run separately: npx vitest run src/tests/sfu-integration.test.ts
      path.join(testsDir, "**/sfu-integration.test.ts")
    ],
    setupFiles: [path.join(testsDir, "setup.ts")]
  }
});
