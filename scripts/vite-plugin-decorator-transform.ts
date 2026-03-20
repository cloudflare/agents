import babel from "@rolldown/plugin-babel";
import type { Plugin } from "vite";

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
