import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: {
    port: 8800,
    strictPort: true,
    proxy: {
      "/chat": {
        target: "http://127.0.0.1:8799",
        ws: true
      }
    }
  }
});
