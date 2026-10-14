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
    // The adapter imports from ../harnesses/pi; resolve pi from one place.
    dedupe: [
      "@earendil-works/chord",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-durable",
      "@earendil-works/pi-telemetry"
    ]
  },
  test: {
    name: "next-channels",
    include: [path.join(testsDir, "**/*.test.ts")],
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
