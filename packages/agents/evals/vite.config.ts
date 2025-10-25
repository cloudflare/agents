import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    dedupe: ["agents"]
  },
  test: {
    setupFiles: ["dotenv/config"]
  }
});
