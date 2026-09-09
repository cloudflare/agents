import type {
  PiBuiltinToolsTestObject,
  PiExecutionEnvTestObject,
  PiHarnessTestObject
} from "./worker";

declare global {
  namespace Cloudflare {
    interface Env {
      PI_HARNESS_TEST: DurableObjectNamespace<PiHarnessTestObject>;
      PI_EXECUTION_ENV_TEST: DurableObjectNamespace<PiExecutionEnvTestObject>;
      PI_BUILTIN_TOOLS_TEST: DurableObjectNamespace<PiBuiltinToolsTestObject>;
    }
  }
}

export {};
