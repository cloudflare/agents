import type { MCPObservabilityEvent } from "../observability/mcp";
import type { AgentMcpOAuthProvider } from "./do-oauth-client-provider";
import type { MCPServersState } from "./client";

export type MCPClientManagerRequestContext = {
  request?: Request;
  connectionUri?: string | null;
};

/** @internal Narrow Agent adapter consumed by MCPClientManager. */
export interface MCPClientManagerHost {
  storage: DurableObjectStorage;
  getAgentClassName(): string;
  getAgentInstanceName(): string;
  getEnv(): Record<string, unknown>;
  getRequestContext(): MCPClientManagerRequestContext;
  getSendIdentityOnConnect(): boolean;
  createAuthProvider(callbackUrl: string): AgentMcpOAuthProvider;
  publishState(state: MCPServersState): void;
  emitObservability(event: MCPObservabilityEvent): void;
}

const hosts = new WeakMap<object, MCPClientManagerHost>();

/** @internal */
export function registerMCPClientManagerHost(
  owner: object,
  host: MCPClientManagerHost
): void {
  hosts.set(owner, host);
}

/** @internal */
export function getMCPClientManagerHost(
  owner: object
): MCPClientManagerHost | undefined {
  return hosts.get(owner);
}
