import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const testsDir = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /effect\/dist\/unstable\/httpapi\/internal\/httpApiScalar\.js$/,
        replacement: path.join(testsDir, "http-api-scalar.ts")
      }
    ],
    dedupe: ["vitest"]
  },
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: path.join(testsDir, "wrangler.jsonc")
      }
    })
  ],
  test: {
    name: "opencode-workers",
    retry: 0,
    include: [path.join(testsDir, "**/*.test.ts")],
    testTimeout: 30_000,
    teardownTimeout: 60_000
  }
});
