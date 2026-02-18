import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  resolve: {
    // Use the Node bundle for just-bash so turndown is bundled in
    // (the browser bundle externalizes it which breaks the Workers runtime)
    conditions: ["import", "module", "default"]
  },
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
