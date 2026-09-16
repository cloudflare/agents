import type { CodexHarnessTestObject } from "./worker";

declare global {
  namespace Cloudflare {
    interface Env {
      CODEX_HARNESS_TEST: DurableObjectNamespace<CodexHarnessTestObject>;
    }
  }
}

export {};
