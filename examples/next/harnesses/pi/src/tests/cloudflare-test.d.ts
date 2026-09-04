import type { PiHarnessTestObject } from "./worker";

declare global {
  namespace Cloudflare {
    interface Env {
      PI_HARNESS_TEST: DurableObjectNamespace<PiHarnessTestObject>;
    }
  }
}

export {};
