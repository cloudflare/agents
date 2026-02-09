import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), cloudflare()],
  define: {
    __filename: "'index.ts'"
  },
  build: {
    minify: true
  }
});
