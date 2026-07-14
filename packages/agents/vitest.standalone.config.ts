import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    name: "standalone-node",
    environment: "node",
    include: [
      "src/tests/observability/ai-sdk-v6-wrap.test.ts",
      "src/tests/observability/ai-sdk-v7-telemetry.test.ts"
    ]
  }
});
