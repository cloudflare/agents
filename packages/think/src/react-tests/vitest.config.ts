import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const testsDir = import.meta.dirname;

export default defineConfig({
  plugins: [react()],
  define: {
    "globalThis.IS_REACT_ACT_ENVIRONMENT": "true"
  },
  test: {
    name: "react",
    environment: "jsdom",
    globals: true,
    include: [path.join(testsDir, "**/*.test.{ts,tsx}")],
    clearMocks: true
  }
});
