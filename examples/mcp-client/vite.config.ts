import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    react(),
    cloudflare({
      // ensure that we can run two instances of the dev server
      inspectorPort: 9230,
    }),
  ],
});
