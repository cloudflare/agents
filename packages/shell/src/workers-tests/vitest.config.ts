import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    name: "shell-workers",
    include: ["src/workers-tests/**/*.test.ts"],
    deps: {
      optimizer: {
        ssr: {
          include: ["sprintf-js"]
        }
      }
    },
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
