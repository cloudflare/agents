import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "x402",
    retry: 3,
    environment: "node",
    clearMocks: true
  }
});
