/// <reference types="@cloudflare/vitest-pool-workers/types" />

interface __TestEnv {
  RoomObject: DurableObjectNamespace<import("../index").RoomObject>;
}

declare namespace Cloudflare {
  interface Env extends __TestEnv {}
  interface GlobalProps {
    mainModule: typeof import("./worker");
    durableNamespaces: "RoomObject";
  }
}

interface Env extends __TestEnv {}
