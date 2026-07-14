import { transform } from "esbuild";
import { defineConfig, type Plugin } from "vitest/config";

/**
 * vitest 4 (rolldown-vite) transforms TS with oxc, which strips types but
 * passes stage-3 ES decorators (`@callable`) through as syntax Node cannot
 * parse yet (oxc only lowers *legacy* decorators). This post-transform hands
 * decorator-bearing modules to esbuild, which does lower 2023-11 decorators
 * at any target below esnext.
 */
function lowerEsDecorators(): Plugin {
  return {
    name: "lower-es-decorators",
    enforce: "post",
    async transform(code, id) {
      if (!/\.tsx?(\?|$)/.test(id) || !/^\s*@[A-Za-z_$]/m.test(code)) return null;
      const result = await transform(code, { loader: "js", target: "es2022", sourcemap: true });
      return { code: result.code, map: result.map };
    },
  };
}

export default defineConfig({
  plugins: [lowerEsDecorators()],
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/adapters/cloudflare/**", "**/node_modules/**"],
    environment: "node",
    testTimeout: 15_000
  }
});
