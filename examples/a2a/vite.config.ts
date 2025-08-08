import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      // a2a-js/sdk has a dependency on express, which vite tries to bundle. This alias prevents that.
      express: path.resolve(__dirname, "./src/express-alias.js")
    }
  },
  plugins: [react(), cloudflare()]
});
