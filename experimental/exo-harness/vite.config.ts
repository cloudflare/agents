import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    agents(),
    react(),
    cloudflare(
      // EXO_OFFLINE=1 uses the config without the Workers AI binding, so dev
      // runs fully offline with the mock model (no Cloudflare credentials).
      process.env.EXO_OFFLINE
        ? { configPath: "./wrangler.offline.jsonc" }
        : undefined
    ),
    tailwindcss()
  ]
});
