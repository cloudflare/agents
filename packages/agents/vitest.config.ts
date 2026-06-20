import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "src/tests/vitest.config.ts",
      "src/react-tests/vitest.config.ts",
      "src/cli-tests/vitest.config.ts",
      "src/x402-tests/vitest.config.ts",
      "src/chat/__tests__/vitest.config.ts",
      "src/webmcp-tests/vitest.config.ts"
      // "src/e2e-tests/vitest.config.ts" — excluded from the default unit target
      //   (spawns real `wrangler dev` + SIGKILL); runs nightly via the `e2e-agents`
      //   job in .github/workflows/nightly.yml, or locally via `pnpm run test:e2e`.
      // "src/browser-tests/vitest.config.ts" — run via `pnpm run test:browser` (spawns wrangler + Chromium)
    ]
  }
});
