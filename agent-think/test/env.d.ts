/// <reference types="@cloudflare/vitest-pool-workers/types" />

// `env` and `SELF` from "cloudflare:test" are typed off `Cloudflare.Env`, which
// wrangler already populates in ../worker-configuration.d.ts (R2_SKILLS, LOADER,
// AI, ASSETS, PUBLIC_BASE_URL, ThinkAgent). We additionally pin `ProvidedEnv` to
// the same shape so any future pool version that reads `ProvidedEnv` stays in
// sync with the real worker Env rather than falling back to `{}`.
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
