import path from "node:path";
import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    name: "chat",
    retry: 3,
    environment: "node",
    include: [path.join(import.meta.dirname, "**/*.test.ts")]
  }
});
