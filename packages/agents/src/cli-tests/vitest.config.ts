import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "cli",
    retry: 3,
    environment: "node",
    clearMocks: true
  }
});
