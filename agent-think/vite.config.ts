import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Builds ONLY the read-only thread UI (a small React SPA) into
// `dist/client`, which wrangler serves as static assets (see the
// `assets` binding in wrangler.jsonc). The worker itself — the
// AgentThink RPC entrypoint, the ThinkAgent DO, the container
// backend — is built by wrangler from `src/index.ts`, not Vite, so
// the container image build is unaffected.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/client",
    emptyOutDir: true
  }
});
