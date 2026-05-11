import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import agents from "agents/vite";
import { stripNodeModulesSourceMapReferences } from "../../../../scripts/vitest/strip-node-modules-source-map-references";
import { defineConfig } from "vitest/config";

const testsDir = import.meta.dirname;

export default defineConfig({
  plugins: [
    stripNodeModulesSourceMapReferences(),
    agents(),
    cloudflareTest({
      wrangler: {
        configPath: path.join(testsDir, "wrangler.jsonc")
      }
    })
  ],
  test: {
    name: "assistant-example",
    include: [path.join(testsDir, "**/*.test.ts")],
    setupFiles: [path.join(testsDir, "setup.ts")],
    testTimeout: 15_000,
    deps: {
      optimizer: {
        ssr: {
          // ajv ships its schema files via require('./*.json') which
          // vitest can't resolve without an explicit hint. Same fix
          // packages/ai-chat and packages/agents use.
          include: ["ajv"]
        }
      }
    }
  }
});
