import path from "node:path";
import { defineConfig } from "vitest/config";

const dir = import.meta.dirname;

// Two suites, each on its own deployment, run as separate projects so they
// can go at once: `--project pi` or `--project opencode` picks one.
export default defineConfig({
  test: {
    // No retries: a failure is a bug in the product or the suite.
    retry: 0,
    hookTimeout: 300_000,
    projects: [
      {
        test: {
          name: "pi",
          include: [path.join(dir, "pi.test.ts")],
          globalSetup: [path.join(dir, "deploy-pi.ts")],
          testTimeout: 300_000
        }
      },
      {
        test: {
          name: "opencode",
          include: [path.join(dir, "opencode.test.ts")],
          globalSetup: [path.join(dir, "deploy-opencode.ts")],
          testTimeout: 300_000
        }
      }
    ]
  }
});
