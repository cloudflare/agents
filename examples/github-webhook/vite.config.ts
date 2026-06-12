import { cloudflare } from "@cloudflare/vite-plugin";
import agents from "agents/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [agents(), cloudflare()]
});
