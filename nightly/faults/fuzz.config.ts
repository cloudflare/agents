import path from "node:path";
import { defineConfig } from "vitest/config";

const minutes = Number(process.env.FUZZ_MINUTES ?? 6);

export default defineConfig({
  test: {
    name: "nightly-fuzz",
    include: [path.join(import.meta.dirname, "fuzz.test.ts")],
    globalSetup: [path.join(import.meta.dirname, "deploy.ts")],
    // No retries: a failure is a bug in the product or the driver.
    retry: 0,
    // The four rooms run at once: the fuzz time, then up to 150 s to
    // settle and a minute for the late tab and the checks.
    maxConcurrency: 4,
    testTimeout: (minutes * 60 + 300) * 1000
  }
});
