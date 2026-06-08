import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    retry: 3,
    environment: "node",
    include: ["tests/**/*.test.ts"]
  }
});
