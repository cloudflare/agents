import type { HostAgent } from "../agents/host";

export interface Env {
  ThinkAgent_Host: DurableObjectNamespace<HostAgent>;
}
