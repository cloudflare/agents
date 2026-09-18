/// <reference types="@cloudflare/vitest-pool-workers/types" />

interface __TestEnv {
  TaskEventsAgent: DurableObjectNamespace<import("../server").TaskEventsAgent>;
}

declare namespace Cloudflare {
  interface Env extends __TestEnv {}
  interface GlobalProps {
    mainModule: typeof import("./worker");
    durableNamespaces: "TaskEventsAgent";
  }
}

interface Env extends __TestEnv {}
