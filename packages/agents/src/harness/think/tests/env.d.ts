/// <reference types="@cloudflare/vitest-pool-workers/types" />

declare namespace Cloudflare {
  interface Env {
    THINK_HARNESS_TEST: DurableObjectNamespace<
      import("./worker").ThinkHarnessTestObject
    >;
    THINK_WITH_STREAMS: DurableObjectNamespace<
      import("./worker").ThinkWithStreamsObject
    >;
  }
}
