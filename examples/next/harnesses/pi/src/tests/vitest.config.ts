import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const testsDir = import.meta.dirname;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: path.join(testsDir, "wrangler.jsonc") }
    })
  ],
  resolve: {
    // Resolve every pi package from this example, so the harness and the
    // tests share one copy of pi's module state.
    dedupe: [
      "@earendil-works/chord",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-durable",
      "@earendil-works/pi-telemetry"
    ]
  },
  test: {
    // harness.test.ts crashes objects with abortAllDurableObjects(), which
    // reaches every object in the runtime, including other files' objects.
    fileParallelism: false,
    name: "next-pi-harness",
    include: [path.join(testsDir, "**/*.test.ts")],
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
