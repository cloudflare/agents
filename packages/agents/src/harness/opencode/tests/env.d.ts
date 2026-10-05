import "@cloudflare/vitest-pool-workers/types";

declare global {
  namespace Cloudflare {
    interface Env {
      OPENCODE_HARNESS_TEST: DurableObjectNamespace<
        import("./worker").OpenCodeHarnessTestObject
      >;
      OPENCODE_MODEL_TEST: DurableObjectNamespace<
        import("./worker").OpenCodeModelTestObject
      >;
      OPENCODE_LEASE_TEST: DurableObjectNamespace<
        import("./worker").OpenCodeLeaseTestObject
      >;
      OPENCODE_SHARED_DATABASE_TEST: DurableObjectNamespace<
        import("./worker").OpenCodeSharedDatabaseTestObject
      >;
    }
  }
}

export {};
