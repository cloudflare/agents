import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["live-tests/delivery.test.ts"],
    testTimeout: 180_000
  }
});
