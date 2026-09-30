import type { PiHarnessTestObject, PiStoreTestObject } from "./worker";

declare global {
  namespace Cloudflare {
    interface Env {
      PI_HARNESS_TEST: DurableObjectNamespace<PiHarnessTestObject>;
      PI_STORE_TEST: DurableObjectNamespace<PiStoreTestObject>;
    }
  }
}

export {};
