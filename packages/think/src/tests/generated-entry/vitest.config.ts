import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { stripNodeModulesSourceMapReferences } from "../../../../../scripts/vitest/strip-node-modules-source-map-references";
import think from "../../vite";

const testsDir = import.meta.dirname;
const fixtureDir = path.join(testsDir, "fixture");

export default defineConfig({
  root: fixtureDir,
  resolve: {
    alias: {
      "@cloudflare/think/server-entry": path.join(
        testsDir,
        "../../server-entry.ts"
      ),
      "@cloudflare/think/framework": path.join(
        testsDir,
        "../../framework/index.ts"
      )
    }
  },
  plugins: [
    stripNodeModulesSourceMapReferences(),
    think({ routePrefix: "/api/agents", allowNonVirtualMain: true }),
    cloudflareTest({
      wrangler: {
        configPath: path.join(fixtureDir, "wrangler.jsonc")
      }
    })
  ],
  test: {
    name: "think-generated-entry-workers",
    include: [path.join(testsDir, "*.test.ts")],
    testTimeout: 10000,
    retry: 3
  }
});
