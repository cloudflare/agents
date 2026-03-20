/// <reference types="@cloudflare/vitest-pool-workers/types" />

type _WorkerEnv = import("./worker").Env;

type _DurableNamespaceKeys<T> = {
  [K in keyof T]: T[K] extends DurableObjectNamespace<unknown> ? K : never;
}[keyof T];

declare namespace Cloudflare {
  interface Env extends _WorkerEnv {}
  interface GlobalProps {
    mainModule: typeof import("./worker");
    durableNamespaces: _DurableNamespaceKeys<_WorkerEnv>;
  }
}
