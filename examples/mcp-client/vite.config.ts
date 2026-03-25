import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    agents(),
    react(),
    cloudflare({
      inspectorPort: 9230
    }),
    tailwindcss()
  ]
});
