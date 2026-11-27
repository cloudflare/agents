/// <reference types="@cloudflare/vitest-plugin/types" />

declare namespace Cloudflare {
  interface Env {
    THINK_HARNESS_TEST: DurableObjectNamespace<
      import("./worker").ThinkHarnessTestObject
    >;
    THINK_WITH_STREAMS: DurableObjectNamespace<
      import("./worker").ThinkWithStreamsObject
    >;
    THINK_HARNESS_FACET_ROOT: DurableObjectNamespace<
      import("./worker").ThinkHarnessFacetRoot
    >;
    THINK_HARNESS_FACET_CHILD: DurableObjectNamespace<
      import("./worker").ThinkHarnessFacetChild
    >;
    THINK_CODEMODE: DurableObjectNamespace<
      import("./worker").ThinkCodemodeObject
    >;
    CODEMODE_SANDBOX: DurableObjectNamespace<
      import("./worker").CodemodeSandbox
    >;
  }
}
