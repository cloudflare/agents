/// <reference types="@cloudflare/vitest-pool-workers/types" />

interface __TestEnv {
  Workspace: DurableObjectNamespace<import("../index").Workspace>;
  Notebook: DurableObjectNamespace<import("../index").Notebook>;
}

declare namespace Cloudflare {
  interface Env extends __TestEnv {}
  interface GlobalProps {
    mainModule: typeof import("./worker");
    durableNamespaces: "Workspace" | "Notebook";
  }
}

interface Env extends __TestEnv {}
