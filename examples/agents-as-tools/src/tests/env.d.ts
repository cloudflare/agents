/// <reference types="@cloudflare/vitest-pool-workers/types" />

type _WorkerEnv = import("./worker").Env;

declare namespace Cloudflare {
  interface Env extends _WorkerEnv {
    // The production wrangler.jsonc binds `AI` for `Researcher.synthesize`
    // and `Assistant.getModel`. Tests deliberately do not bind it (see
    // wrangler.jsonc rationale): registry/replay tests don't trigger the
    // synthesis path, and the byte-stream test asserts the error path
    // that fires when `synthesize` is called without a binding.
    // Declared here so `src/server.ts` typechecks under the test
    // tsconfig.
    AI: Ai;
  }
  interface GlobalProps {
    mainModule: typeof import("./worker");
  }
}

interface Env extends Cloudflare.Env {}
