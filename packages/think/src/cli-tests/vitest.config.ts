import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    name: "think-cli",
    environment: "node",
    clearMocks: true,
    include: ["src/cli-tests/**/*.test.ts"]
  }
});
