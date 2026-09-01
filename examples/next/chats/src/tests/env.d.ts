/// <reference types="@cloudflare/vitest-pool-workers/types" />

interface __TestEnv {
  UserAgent: DurableObjectNamespace<import("./worker").TestUserAgent>;
  ChatAgent: DurableObjectNamespace<import("../index").ChatAgent>;
}

declare namespace Cloudflare {
  interface Env extends __TestEnv {}
  interface GlobalProps {
    mainModule: typeof import("./worker");
    durableNamespaces: "TestUserAgent" | "ChatAgent";
  }
}

interface Env extends __TestEnv {}
