import "@cloudflare/vitest-pool-workers/types";

import type { OpenCodeHarnessTestObject } from "./worker";

declare global {
  namespace Cloudflare {
    interface Env {
      OPENCODE_HARNESS_TEST: DurableObjectNamespace<OpenCodeHarnessTestObject>;
    }
  }
}

export {};
