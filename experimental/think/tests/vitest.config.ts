import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    name: "think-workers",
    include: ["**/*.test.ts"],
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
