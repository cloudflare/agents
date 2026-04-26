/// <reference types="@cloudflare/vitest-pool-workers/types" />

type _WorkerEnv = import("./worker").Env;

declare namespace Cloudflare {
  interface Env extends _WorkerEnv {
    // Bindings declared in the production wrangler.jsonc that the
    // test worker doesn't carry (auth secrets, Workers AI). Tests
    // don't exercise the code paths that read these — auth lives in
    // the production Worker (which the test worker replaces) and AI
    // is only touched by `MyAssistant.getModel()` during turns
    // (which tests don't trigger). Declared here so `src/server.ts`
    // and `src/auth.ts` typecheck under the test tsconfig.
    AI: Ai;
    GITHUB_CLIENT_ID: string;
    GITHUB_CLIENT_SECRET: string;
  }
  interface GlobalProps {
    mainModule: typeof import("./worker");
  }
}

interface Env extends Cloudflare.Env {}
