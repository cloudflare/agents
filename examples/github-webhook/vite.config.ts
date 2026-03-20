import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import decorators from "../../scripts/vite-plugin-decorator-transform";

export default defineConfig({
  plugins: [decorators(), cloudflare()]
});
