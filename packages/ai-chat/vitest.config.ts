import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    projects: ["src/tests/vitest.config.ts", "src/react-tests/vitest.config.ts"]
  }
});
