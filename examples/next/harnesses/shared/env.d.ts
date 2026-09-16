/**
 * Bindings of the test worker (`src/tests/wrangler.jsonc`). The package
 * itself ships no Worker, so this is the only `Env` it needs.
 */
import type { RemoteHarnessTestObject } from "./src/tests/remote-worker";
import type { HarnessTestObject } from "./src/tests/worker";

declare global {
  interface Env {
    HARNESS_TEST: DurableObjectNamespace<HarnessTestObject>;
    REMOTE_HARNESS_TEST: DurableObjectNamespace<RemoteHarnessTestObject>;
  }
  namespace Cloudflare {
    interface Env {
      HARNESS_TEST: DurableObjectNamespace<HarnessTestObject>;
      REMOTE_HARNESS_TEST: DurableObjectNamespace<RemoteHarnessTestObject>;
    }
  }
}

export {};
