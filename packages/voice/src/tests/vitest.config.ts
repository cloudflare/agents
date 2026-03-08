import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    name: "voice-workers",
    exclude: [
      // SFU integration tests need real API credentials via process.env.
      // Run separately: npx vitest run src/tests/sfu-integration.test.ts
      "**/sfu-integration.test.ts"
    ],
    setupFiles: ["./setup.ts"],
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
