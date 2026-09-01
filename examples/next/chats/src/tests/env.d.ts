/// <reference types="@cloudflare/vitest-pool-workers/types" />

interface __TestEnv {
  UserAgent: DurableObjectNamespace<import("../index").UserAgent>;
  ChatAgent: DurableObjectNamespace<import("../index").ChatAgent>;
}

declare namespace Cloudflare {
  interface Env extends __TestEnv {}
  interface GlobalProps {
    mainModule: typeof import("./worker");
    durableNamespaces: "UserAgent" | "ChatAgent";
  }
}

interface Env extends __TestEnv {}
