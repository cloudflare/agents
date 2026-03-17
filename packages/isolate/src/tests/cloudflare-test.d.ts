import type { TestWorkspaceAgent } from "./agents/workspace";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    LOADER: WorkerLoader;
    TestWorkspaceAgent: DurableObjectNamespace<TestWorkspaceAgent>;
  }
}
