import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  plugins: [
    agents(),
    react(),
    cloudflare(
      command === "serve"
        ? {
            config(config) {
              config.secrets = { required: [] };
            }
          }
        : undefined
    ),
    tailwindcss()
  ]
}));
