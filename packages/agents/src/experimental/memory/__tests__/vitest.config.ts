import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    clearMocks: true,
    root: path.resolve(import.meta.dirname),
    include: ["./*.test.ts"]
  }
});
