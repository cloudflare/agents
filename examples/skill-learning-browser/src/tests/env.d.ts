/// <reference types="@cloudflare/vitest-pool-workers/types" />

type _WorkerEnv = import("./worker").Env;

declare namespace Cloudflare {
  interface Env extends _WorkerEnv {
    // The production wrangler.jsonc binds `AI` for inference.
    // Tests deliberately omit it (see wrangler.jsonc rationale):
    // skill registry and execution tests never reach the LLM path.
    // Declared here so src/server.ts typechecks under the test tsconfig.
    AI: Ai;
  }
  interface GlobalProps {
    mainModule: typeof import("./worker");
  }
}

interface Env extends Cloudflare.Env {}
