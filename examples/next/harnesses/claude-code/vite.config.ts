import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    agents(),
    react(),
    cloudflare({ inspectorPort: 9243 }),
    tailwindcss()
  ],
  resolve: {
    // One React for the app and the shared hook, whatever pnpm links where.
    dedupe: ["react", "react-dom"]
  }
});
