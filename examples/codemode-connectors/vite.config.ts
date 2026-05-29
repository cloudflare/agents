import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import agents from "agents/vite";
import codemode from "@cloudflare/codemode/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [agents(), codemode(), react(), cloudflare(), tailwindcss()]
});
