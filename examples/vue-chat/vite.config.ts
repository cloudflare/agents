import { cloudflare } from "@cloudflare/vite-plugin";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue(), cloudflare()]
});
