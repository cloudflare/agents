import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const dir = path.dirname(fileURLToPath(import.meta.url));

// Think Studio is a standalone SPA (no Workers runtime): `think studio` serves
// the prebuilt bundle from a tiny `node:http` server and the app talks to the
// target Think instance directly over a WebSocket. `base: "./"` keeps asset
// URLs relative so the bundle works regardless of the mount path.
export default defineConfig({
  root: dir,
  base: "./",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.resolve(dir, "../dist/studio"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000
  }
});
