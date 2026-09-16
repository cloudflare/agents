import type { TestSelfModifyingHarnessObject } from "./worker";

declare global {
  namespace Cloudflare {
    interface Env {
      SELF_MODIFYING_HARNESS_TEST: DurableObjectNamespace<TestSelfModifyingHarnessObject>;
    }
  }
}

export {};
