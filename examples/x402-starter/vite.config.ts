import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "public",
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      "/chat": "http://localhost:8787",
      "/api": "http://localhost:8787",
      "/mcp": "http://localhost:8787"
    }
  }
});
