import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), cloudflare({ inspectorPort: 9242 }), tailwindcss()],
  resolve: {
    // The commit-pinned pi artifacts intentionally omit sibling package
    // dependencies. Resolve every internal pi import from this example's
    // node_modules so one revision supplies all provider and harness types.
    dedupe: [
      "@earendil-works/chord",
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-session-backend-sqlite-node",
      "@earendil-works/pi-telemetry"
    ]
  }
});
