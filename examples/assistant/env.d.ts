// Hand-maintained platform bindings for the assistant Worker.
//
// The `AssistantDirectory` Durable Object binding is generated into
// `think.d.ts` by `think types` (run `npm run types`). This file declares
// the remaining app bindings — Workers AI and the GitHub OAuth secrets —
// so we don't run `wrangler types` (which would re-emit the DO binding and
// collide with the typed one in `think.d.ts`).
declare namespace Cloudflare {
  interface Env {
    LOADER: WorkerLoader;
    AI: Ai;
    BROWSER: Fetcher;
    GITHUB_CLIENT_ID: string;
    GITHUB_CLIENT_SECRET: string;
    /**
     * Local-dev escape hatch — see `getDevUser` in src/server.ts.
     * Defaults to "" (disabled) via `vars` in wrangler.jsonc.
     */
    DEV_USER: string;
  }
}

interface Env extends Cloudflare.Env {}

declare namespace NodeJS {
  interface ProcessEnv {
    GITHUB_CLIENT_ID: string;
    GITHUB_CLIENT_SECRET: string;
  }
}
