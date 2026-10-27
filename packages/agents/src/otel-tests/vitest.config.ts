import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "otel-runtime",
    environment: "node",
    include: [path.join(import.meta.dirname, "*.test.ts")],
    testTimeout: 60_000,
    hookTimeout: 300_000
  }
});
