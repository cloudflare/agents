import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import decorators from "../../scripts/vite-plugin-decorator-transform";

export default defineConfig({
  plugins: [
    decorators(),
    react(),
    tailwindcss(),
    cloudflare({
      // ensure that we can run two instances of the dev server
      inspectorPort: 9230
    })
  ]
});
