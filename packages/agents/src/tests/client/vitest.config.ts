import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globalSetup: "global-setup.ts",
    poolOptions: {
      workers: {
        isolatedStorage: false,
        singleWorker: false,
        wrangler: {
          configPath: "./wrangler.toml",
        },
      },
    },
  },
});
