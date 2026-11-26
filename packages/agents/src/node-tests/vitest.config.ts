import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "node",
    retry: 0,
    environment: "node",
    clearMocks: true
  }
});
