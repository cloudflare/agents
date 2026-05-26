import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { think } from "@cloudflare/think/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [think(), react(), cloudflare(), tailwindcss()]
});
