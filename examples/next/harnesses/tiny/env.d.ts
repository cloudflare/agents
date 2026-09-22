/**
 * Hand-written type surface that `wrangler types` cannot generate.
 *
 * The bindings themselves live in `worker-env.d.ts`, generated from
 * wrangler.jsonc by `wrangler types` on postinstall and deliberately not
 * committed. This file only carries what generation gets wrong.
 *
 * `AI` is the one case. Wrangler types it with the *ambient* `Ai` global,
 * but `@tanstack/ai-cloudflare` types its `binding` option with the `Ai`
 * exported from `@cloudflare/workers-types` — and TypeScript treats the
 * ambient and module declarations as distinct types even at identical
 * versions. Left as generated, `env.AI` fails to satisfy the adapter that
 * exists to receive it. Re-declaring the member with the module type is what
 * makes model.ts compile.
 */
import type { Ai } from "@cloudflare/workers-types";

declare global {
  interface Env {
    AI: Ai;
  }
}

export {};
