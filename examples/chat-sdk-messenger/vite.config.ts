import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

const tunnel = process.env.TUNNEL === "1" ? { autoStart: true } : undefined;

export default defineConfig({
  plugins: [agents(), react(), cloudflare({ tunnel }), tailwindcss()]
});
