import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    name: "cli",
    retry: 3,
    environment: "node",
    clearMocks: true
  }
});
