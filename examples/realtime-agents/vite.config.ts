import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [cloudflare()],
  define: {
    __filename: "'index.ts'"
  },
  build: {
    minify: true
  }
});
