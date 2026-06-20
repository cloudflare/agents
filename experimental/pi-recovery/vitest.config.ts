import { defineConfig } from "vitest/config";

// Plain-node unit tests (the codec is pure — no Workers runtime needed). The
// SIGKILL e2e has its own config under e2e/.
export default defineConfig({
  test: {
    name: "pi-recovery",
    include: ["src/**/*.test.ts"]
  }
});
