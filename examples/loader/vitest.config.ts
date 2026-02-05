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
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        // Use single worker to avoid isolation issues with SQLite DOs
        isolatedStorage: false
      }
    }
  }
});
