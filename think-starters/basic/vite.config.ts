import { cloudflare } from "@cloudflare/vite-plugin";
import { think } from "@cloudflare/think/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [think(), react(), cloudflare()]
});
