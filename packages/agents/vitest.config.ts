import { defineConfig } from "vitest/config";
import { CRASH_REASON } from "./src/harness/pi/tests/crash";

export default defineConfig({
  test: {
    // The pi harness tests crash an object on purpose, and its in-flight
    // work rejects with the crash's reason. Vitest reads this only here, in
    // the root config, so it matches that one reason exactly; any other
    // unhandled error still fails the run.
    onUnhandledError: (error) => error.message !== CRASH_REASON,
    projects: [
      "src/tests/vitest.config.ts",
      "src/react-tests/vitest.config.ts",
      "src/voice/tests/vitest.config.ts",
      "src/voice/react-tests/vitest.config.ts",
      "src/harness/pi/tests/vitest.config.ts",
      "src/channels/vitest.config.ts",
      "src/node-tests/vitest.config.ts",
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
