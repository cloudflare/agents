import type {
  PiNoDefaultsTestObject,
  PiHarnessTestObject,
  PiStoreTestObject
} from "./worker";

declare global {
  namespace Cloudflare {
    interface Env {
      PI_HARNESS_TEST: DurableObjectNamespace<PiHarnessTestObject>;
      PI_STORE_TEST: DurableObjectNamespace<PiStoreTestObject>;
      PI_NO_DEFAULTS_TEST: DurableObjectNamespace<PiNoDefaultsTestObject>;
    }
  }
}

export {};
