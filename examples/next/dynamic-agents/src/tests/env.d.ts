/// <reference types="@cloudflare/vitest-pool-workers/types" />

interface __TestEnv {
  Supervisor: DurableObjectNamespace<import("../index").Supervisor>;
  LOADER: WorkerLoader;
}

declare namespace Cloudflare {
  interface Env extends __TestEnv {}
  interface GlobalProps {
    mainModule: typeof import("./worker");
    durableNamespaces: "Supervisor";
  }
}

interface Env extends __TestEnv {}
