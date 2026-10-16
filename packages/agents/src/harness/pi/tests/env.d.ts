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
    PI_FACTORY_TEST: DurableObjectNamespace<
      import("./worker").PiFactoryTestObject
    >;
    PI_FLAKY_FACTORY_TEST: DurableObjectNamespace<
      import("./worker").PiFlakyFactoryTestObject
    >;
    PI_BROWSER_TEST: DurableObjectNamespace<
      import("./worker").PiBrowserTestObject
    >;
    PI_WAKE_TEST: DurableObjectNamespace<import("./worker").PiWakeTestObject>;
    PI_QUARANTINE_TEST: DurableObjectNamespace<
      import("./worker").PiQuarantineTestObject
    >;
    PI_ON_FAIL_RESUME_TEST: DurableObjectNamespace<
      import("./worker").PiOnFailResumeTestObject
    >;
    PI_ON_FAIL_ABORT_TEST: DurableObjectNamespace<
      import("./worker").PiOnFailAbortTestObject
    >;
    PI_DEADLINE_TEST: DurableObjectNamespace<
      import("./worker").PiDeadlineTestObject
    >;
    LOADER: WorkerLoader;
  }
}
