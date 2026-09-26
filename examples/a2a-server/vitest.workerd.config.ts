import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        bindings: {
          A2A_BEARER_TOKEN: "workerd-test-token"
        }
      }
    })
  ],
  test: {
    include: ["test/workerd.integration.ts"],
    testTimeout: 30_000
  }
});
