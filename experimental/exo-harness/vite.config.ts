import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  resolve: { dedupe: ["react", "react-dom"] },
  plugins: [
    agents(),
    react(),
    cloudflare(
      // EXO_OFFLINE=1 → no Cloudflare bindings, deterministic mock model.
      // Otherwise `vite dev` uses wrangler.dev.jsonc (different worker name
      // so the remote-bindings tunnel avoids the Access-protected prod
      // host), while `vite build` (deploy) uses the real wrangler.jsonc.
      process.env.EXO_OFFLINE
        ? { configPath: "./wrangler.offline.jsonc" }
        : command === "serve"
          ? { configPath: "./wrangler.dev.jsonc" }
          : undefined
    ),
    tailwindcss()
  ]
}));
