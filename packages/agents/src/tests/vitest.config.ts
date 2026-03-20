import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import decorators from "../../../../scripts/vite-plugin-decorator-transform";
import { defineConfig } from "vitest/config";

const testsDir = import.meta.dirname;

export default defineConfig({
  plugins: [
    decorators(),
    cloudflareTest({
      wrangler: {
        configPath: path.join(testsDir, "wrangler.jsonc")
      }
    })
  ],
  test: {
    name: "workers",
    include: [path.join(testsDir, "**/*.test.ts")],
    // Exclude experimental fiber tests — they hang in CI.
    // Run locally with: npx vitest run src/tests/fiber.test.ts
    exclude: [path.join(testsDir, "**/fiber.test.ts")],
    setupFiles: [path.join(testsDir, "setup.ts")],
    testTimeout: 10000,
    deps: {
      optimizer: {
        ssr: {
          include: ["ajv"]
        }
      }
    }
  }
});
