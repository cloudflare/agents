import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import babel from "@rolldown/plugin-babel";

// Vite 8 replaced esbuild with Oxc for TS transforms. Oxc doesn't support
// TC39 decorators yet (oxc#9170), so @callable() causes a SyntaxError at
// runtime. This Babel pass handles decorators until Oxc lands support.
function decorators() {
  return babel({
    presets: [
      {
        preset: () => ({
          plugins: [
            ["@babel/plugin-proposal-decorators", { version: "2023-11" }]
          ]
        }),
        rolldown: { filter: { code: "@" } }
      }
    ]
  });
}

export default defineConfig({
  plugins: [decorators(), react(), tailwindcss(), cloudflare()],
  define: {
    __filename: "'index.ts'"
  }
});
