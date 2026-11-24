/// <reference types="@cloudflare/vitest-plugin/types" />

declare namespace Cloudflare {
  interface Env {
    TABLE_PREFIX_TEST: DurableObjectNamespace<
      import("./worker").TablePrefixTestObject
    >;
    OPENCODE_HARNESS_TEST: DurableObjectNamespace<
      import("./worker").OpenCodeHarnessTestObject
    >;
  }
}
