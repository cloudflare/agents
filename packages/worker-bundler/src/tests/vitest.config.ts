import path from "node:path";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

const testsDir = import.meta.dirname;

export default defineWorkersConfig({
  test: {
    name: "workers",
    include: [path.join(testsDir, "**/*.test.ts")],
    // Copies esbuild.wasm into src/ before tests, removes after
    globalSetup: [path.join(testsDir, "global-setup.ts")],
    poolOptions: {
      workers: {
        isolatedStorage: false,
        singleWorker: true,
        wrangler: {
          configPath: path.join(testsDir, "wrangler.jsonc")
        }
      }
    }
  }
});
