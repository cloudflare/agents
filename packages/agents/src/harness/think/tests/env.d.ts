/// <reference types="@cloudflare/vitest-plugin/types" />

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
