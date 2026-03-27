import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "webmcp",
    environment: "node",
    clearMocks: true
  }
});
