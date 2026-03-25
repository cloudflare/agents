import babel from "@rolldown/plugin-babel";
import type { Plugin } from "vite";

/**
 * Vite plugin for Agents SDK projects.
 *
 * Currently handles TC39 decorator transforms (Oxc doesn't support them yet,
 * oxc#9170) so `@callable()` works at runtime. Will grow to cover other
 * Agents-specific build concerns as needed.
 */
export default function agents(): Plugin {
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
  }) as unknown as Plugin;
}
