/// <reference types="@cloudflare/vitest-pool-workers/types" />

interface __TestEnv {
  UserHub: DurableObjectNamespace<import("../index").UserHub>;
  ChatAgent: DurableObjectNamespace<import("../index").ChatAgent>;
}

declare namespace Cloudflare {
  interface Env extends __TestEnv {}
  interface GlobalProps {
    mainModule: typeof import("./worker");
    durableNamespaces: "UserHub" | "ChatAgent";
  }
}

interface Env extends __TestEnv {}
