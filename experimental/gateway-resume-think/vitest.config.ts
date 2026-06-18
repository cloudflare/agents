import { defineConfig } from "vitest/config";

// Hermetic unit tests for the Layer-B glue (planResume decision + re-attach
// stream against a mocked binding). No Workers runtime / live gateway needed —
// the live end-to-end path is exercised by scripts/driver.mjs against a deploy.
export default defineConfig({
  test: {
    name: "gateway-resume-think",
    environment: "node",
    include: ["src/**/*.test.ts"]
  }
});
