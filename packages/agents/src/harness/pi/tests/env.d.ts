/// <reference types="@cloudflare/vitest-pool-workers/types" />

declare namespace Cloudflare {
  interface Env {
    PI_HARNESS_TEST: DurableObjectNamespace<
      import("./worker").PiHarnessTestObject
    >;
    PI_STORE_TEST: DurableObjectNamespace<import("./worker").PiStoreTestObject>;
    PI_NO_DEFAULTS_TEST: DurableObjectNamespace<
      import("./worker").PiNoDefaultsTestObject
    >;
    PI_EXTENSIONS_TEST: DurableObjectNamespace<
      import("./worker").PiExtensionsTestObject
    >;
    PI_FLAKY_EXTENSION_TEST: DurableObjectNamespace<
      import("./worker").PiFlakyExtensionTestObject
    >;
  }
}
