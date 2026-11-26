import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "x402",
    retry: 0,
    environment: "node",
    clearMocks: true
  }
});
