import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    name: "workers",
    // Exclude experimental fiber tests — they hang in CI.
    // Run locally with: npx vitest run src/tests/fiber.test.ts
    exclude: ["**/fiber.test.ts"],
    deps: {
      optimizer: {
        ssr: {
          include: [
            // vitest can't seem to properly import
            // `require('./path/to/anything.json')` files,
            // which ajv uses (by way of @modelcontextprotocol/sdk)
            // the workaround is to add the package to the include list
            "ajv"
          ]
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
