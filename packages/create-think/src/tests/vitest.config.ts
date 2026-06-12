import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    name: "create-think",
    environment: "node",
    clearMocks: true,
    include: ["src/tests/**/*.test.ts"]
  }
});
