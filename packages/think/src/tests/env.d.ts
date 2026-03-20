/// <reference types="@cloudflare/vitest-pool-workers/types" />

type _WorkerEnv = import("./worker").Env;

declare namespace Cloudflare {
  interface Env extends _WorkerEnv {}
  interface GlobalProps {
    mainModule: typeof import("./worker");
  }
}
