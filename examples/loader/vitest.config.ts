import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  // Bundle just-bash and its dependencies for the test environment
  optimizeDeps: {
    include: ["just-bash", "turndown"]
  },
  ssr: {
    // Force bundling of these packages in SSR/Worker environment
    noExternal: ["just-bash", "turndown"]
  },
  test: {
    // Don't run tests in parallel to avoid SQLite isolation issues
    sequence: {
      concurrent: false
    },
    // Exclude e2e tests - they run separately with vitest.e2e.config.ts
    exclude: ["e2e/**", "**/node_modules/**"],
    poolOptions: {
      workers: {
        // Use test-specific wrangler config that uses server.ts (no BrowserLoopback)
        // This avoids bundling @cloudflare/playwright which requires node:child_process
        wrangler: { configPath: "./wrangler.test.jsonc" },
        // Use single worker to avoid isolation issues with SQLite DOs
        isolatedStorage: false
      }
    }
  }
});
