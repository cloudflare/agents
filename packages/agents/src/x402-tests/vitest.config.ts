import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    name: "x402",
    retry: 3,
    environment: "node",
    clearMocks: true
  }
});
