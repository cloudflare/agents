import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "x402",
    environment: "node",
    clearMocks: true
  }
});
