import { cloudflare } from "@cloudflare/vite-plugin";
import { think } from "@cloudflare/think/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [think(), react(), cloudflare(), tailwindcss()]
});
