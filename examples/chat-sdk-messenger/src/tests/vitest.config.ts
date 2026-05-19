import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import agents from "agents/vite";
import { stripNodeModulesSourceMapReferences } from "../../../../scripts/vitest/strip-node-modules-source-map-references";
import { defineConfig } from "vitest/config";

const testsDir = import.meta.dirname;

export default defineConfig({
  plugins: [
    stripNodeModulesSourceMapReferences(),
    agents(),
    cloudflareTest({
      wrangler: {
        configPath: path.join(testsDir, "wrangler.jsonc")
      }
    })
  ],
  test: {
    name: "chat-sdk-messenger-example",
    include: [path.join(testsDir, "**/*.test.ts")],
    testTimeout: 15_000
  }
});
