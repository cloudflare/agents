import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import agents from "agents/vite";
import { defineConfig } from "vitest/config";

const testsDir = import.meta.dirname;

export default defineConfig({
  plugins: [
    agents(),
    cloudflareTest({
      wrangler: {
        configPath: path.join(testsDir, "wrangler.jsonc")
      }
    })
  ],
  test: {
    name: "agents-as-tools-example",
    include: [path.join(testsDir, "**/*.test.ts")],
    setupFiles: [path.join(testsDir, "setup.ts")],
    testTimeout: 15_000,
    deps: {
      optimizer: {
        ssr: {
          // ajv ships its schema files via `require('./*.json')` which
          // vitest can't resolve without an explicit hint. Same fix
          // packages/ai-chat and examples/assistant tests use.
          include: ["ajv"]
        }
      }
    }
  }
});
