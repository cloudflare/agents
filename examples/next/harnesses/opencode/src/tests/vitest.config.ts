import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
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
    cloudflareTest({
      wrangler: { configPath: path.join(testsDir, "wrangler.jsonc") }
    })
  ],
  resolve: {
    // One copy of OpenCode's client for the SDK and the harness.
    dedupe: ["@opencode/client", "@opencode/sdk"]
  },
  test: {
    name: "next-opencode-harness",
    include: [path.join(testsDir, "**/*.test.ts")],
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
