/// <reference types="@cloudflare/vitest-pool-workers/types" />

interface __TestEnv {
  HubObject: DurableObjectNamespace<import("../index").HubObject>;
  NoteAgent: DurableObjectNamespace<import("../index").NoteAgent>;
}

declare namespace Cloudflare {
  interface Env extends __TestEnv {}
  interface GlobalProps {
    mainModule: typeof import("./worker");
    durableNamespaces: "HubObject" | "NoteAgent";
  }
}

interface Env extends __TestEnv {}
