import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    setupFiles: ["dotenv/config"]
  }
});
