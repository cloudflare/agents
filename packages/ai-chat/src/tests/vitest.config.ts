import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { stripNodeModulesSourceMapReferences } from "../../../../scripts/vitest/strip-node-modules-source-map-references";
import { defineConfig } from "vitest/config";

const testsDir = import.meta.dirname;

export default defineConfig({
  plugins: [
    stripNodeModulesSourceMapReferences(),
    cloudflareTest({
      wrangler: {
        configPath: path.join(testsDir, "wrangler.jsonc")
      }
    })
  ],
  test: {
    name: "workers",
    include: [path.join(testsDir, "**/*.test.ts")],
    setupFiles: [path.join(testsDir, "setup.ts")],
    testTimeout: 10000,
    retry: 3,
    // Under the full parallel matrix, tearing down the workers-pool isolates can
    // overrun vitest's 10s default and surface as "Worker exited unexpectedly"
    // (an infra teardown race, not a test failure that `retry` can catch). Give
    // the pool room to terminate cleanly so a slow teardown can't red an
    // otherwise-green run.
    teardownTimeout: 60_000,
    deps: {
      optimizer: {
        ssr: {
          include: [
            // vitest can't seem to properly import
            // `require('./path/to/anything.json')` files,
            // which ajv uses (by way of @modelcontextprotocol/sdk)
            // the workaround is to add the package to the include list
            "ajv"
          ]
        }
      }
    }
  }
});
