import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { stripNodeModulesSourceMapReferences } from "../../scripts/vitest/strip-node-modules-source-map-references";
import { defineConfig } from "vitest/config";

// WorkerJavaScriptBackend tests. A Durable Object host connects the
// backend to its own SQLite and an in-memory filesystem and runs code in
// real Dynamic Workers.
export default defineConfig({
  plugins: [
    stripNodeModulesSourceMapReferences(),
    cloudflareTest({
      wrangler: { configPath: "./src/tests/wrangler.jsonc" }
    })
  ],
  test: {
    name: "worker-javascript",
    include: ["src/tests/**/*.test.ts"],
    testTimeout: 30_000
  }
});
