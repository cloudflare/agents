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
    // One copy of OpenCode's client for the SDK and the harness: the harness
    // reaches OpenCode's HTTP API through the client the SDK makes.
    dedupe: ["react", "react-dom", "@opencode/client", "@opencode/sdk"]
  }
});
