import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const root = import.meta.dirname;

export default defineConfig({
  plugins: [
    cloudflareTest({
      remoteBindings: false,
      wrangler: { configPath: path.join(root, "wrangler.test.jsonc") }
    })
  ],
  test: {
    name: "codemode-rlm-workers",
    include: [path.join(root, "test/**/*.test.ts")],
    testTimeout: 15_000
  }
});
