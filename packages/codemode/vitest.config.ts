import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    name: "workers",
    include: ["src/test/**/*.test.ts"],
    poolOptions: {
      workers: {
        isolatedStorage: false,
        singleWorker: true,
        wrangler: {
          configPath: "./wrangler.jsonc"
        }
      }
    }
  }
});
