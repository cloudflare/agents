import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Compat-matrix config (Layer B). Runs ONLY the date-agnostic `compat-*.test.ts`
// files, overriding the runtime compatibility date via the COMPAT_DATE env var
// (compatibilityFlags are left as-is from wrangler.jsonc, since the suite needs
// the nodejs test flags). The main `vitest.config.ts` keeps the full suite
// pinned at the repository-standard date in wrangler.jsonc.
const compatDate = process.env.COMPAT_DATE;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: path.join(import.meta.dirname, "wrangler.jsonc")
      },
      ...(compatDate ? { miniflare: { compatibilityDate: compatDate } } : {})
    })
  ],
  test: {
    setupFiles: [path.join(import.meta.dirname, "setup.ts")],
    include: [path.join(import.meta.dirname, "compat-*.test.ts")]
  }
});
