import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["src/test/**/*.test.ts"],
    environment: "node"
  },
  resolve: {
    alias: {
      "cloudflare:workers": path.resolve(__dirname, "src/test/__mocks__/cloudflare-workers.ts")
    }
  }
});
