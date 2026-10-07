/// <reference types="@cloudflare/vitest-pool-workers/types" />

declare namespace Cloudflare {
  interface Env {
    CONTAINER_HARNESS_TEST: DurableObjectNamespace<
      import("./worker").ContainerHarnessTestObject
    >;
    CONTAINER_RETRY_TEST: DurableObjectNamespace<
      import("./worker").ContainerRetryTestObject
    >;
    CONTAINER_MANAGED_TEST: DurableObjectNamespace<
      import("./worker").ContainerManagedTestObject
    >;
    HARNESS_STORE_TEST: DurableObjectNamespace<
      import("./store-fixture").HarnessStoreTestObject
    >;
  }
}
