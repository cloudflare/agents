import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    agents(),
    react(),
    tailwindcss(),
    cloudflare({
      remoteBindings: false,
      inspectorPort: 9230
    })
  ],
  define: {
    __filename: "'index.ts'"
  }
});
