import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    retry: 3,
    include: ["src/**/*.test.ts"]
  }
});
