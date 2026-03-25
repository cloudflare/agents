import babel from "@rolldown/plugin-babel";
import type { Plugin } from "vite";

// Vite 8 replaced esbuild with Oxc for TS transforms. Oxc doesn't support
// TC39 decorators yet (oxc#9170), so @callable() causes a SyntaxError at
// runtime. This Babel pass handles decorators until Oxc lands support.
export default function decorators(): Plugin {
  return babel({
    presets: [
      {
        preset: () => ({
          plugins: [
            ["@babel/plugin-proposal-decorators", { version: "2023-11" }]
          ]
        }),
        rolldown: {
          filter: { code: "@" }
        }
      }
    ]
  }) as unknown as Plugin;
}
