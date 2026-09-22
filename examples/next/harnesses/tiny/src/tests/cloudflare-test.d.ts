/**
 * Test-only bindings.
 *
 * The production `Env` comes from `wrangler types`; these two Durable Object
 * namespaces exist only in `src/tests/wrangler.jsonc`, so they are declared
 * here rather than regenerated into the checked-in `env.d.ts`.
 */
import type { TestAgent, TestSubagent } from "./worker";

declare global {
  namespace Cloudflare {
    interface Env {
      TINY_TEST: DurableObjectNamespace<TestAgent>;
      TINY_TEST_SUBAGENT: DurableObjectNamespace<TestSubagent>;
    }
  }
}

export {};
