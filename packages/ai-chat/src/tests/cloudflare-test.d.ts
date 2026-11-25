/// <reference types="@cloudflare/vitest-plugin/types" />

type _WorkerEnv = import("./worker").Env;

declare namespace Cloudflare {
  interface Env extends _WorkerEnv {}
  interface GlobalProps {
    mainModule: typeof import("./worker");
  }
}
