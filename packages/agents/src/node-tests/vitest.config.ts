import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./otel/cloudflare-workers.ts", import.meta.url)
      )
    }
  },
  test: {
    name: "node",
    retry: 3,
    environment: "node",
    clearMocks: true
  }
});
