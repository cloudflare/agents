/**
 * Type tests for agent props typing.
 *
 * Interfaces do not get implicit index signatures in TypeScript, so a
 * `Record<string, unknown>` bound rejects user-defined interfaces with
 * "Index signature for type 'string' is missing". Props bounds and prop-bag
 * options must accept plain interfaces (#1886) while still rejecting
 * non-object props.
 */
import type { env } from "cloudflare:workers";
import { Agent, getAgentByName, type AgentGetOptions } from "..";
import { McpAgent } from "../mcp";
import type { RPCClientTransportOptions } from "../mcp/rpc";

// A well-defined interface with NO index signature — the shape from #1886.
interface AuthProps {
  userId: string;
  permissions: string[];
}

declare const authProps: AuthProps;
declare const agentNamespace: DurableObjectNamespace<Agent<typeof env>>;

// ============================================
// POSITIVE TESTS - interface props must be accepted
// ============================================

// getAgentByName must accept interface-typed props (the #1886 repro).
getAgentByName(agentNamespace, "instance", { props: authProps });

// Explicit Props type argument must be instantiable with an interface.
getAgentByName<typeof env, Agent<typeof env>, AuthProps>(
  agentNamespace,
  "instance",
  { props: authProps }
);

// AgentGetOptions must be instantiable with an interface.
declare const options: AgentGetOptions<typeof env, AuthProps>;
options.props satisfies AuthProps | undefined;

// Agent and McpAgent must be instantiable with interface Props.
declare class AuthAgent extends Agent<typeof env, unknown, AuthProps> {}
declare class AuthMcpAgent extends McpAgent<typeof env, unknown, AuthProps> {
  server: never;
  init(): Promise<void>;
}

// Props typing flows through to the instance.
declare const authMcpAgent: AuthMcpAgent;
authMcpAgent.props satisfies AuthProps | undefined;

// addMcpServer's RPC options must accept interface-typed props.
declare const mcpNamespace: DurableObjectNamespace<AuthMcpAgent>;
declare const authAgent: AuthAgent;
authAgent.addMcpServer("internal-tools", mcpNamespace, { props: authProps });

// The direct mcp.connect transport options must accept an interface-Props
// McpAgent namespace.
declare const rpcTransportOptions: RPCClientTransportOptions<AuthMcpAgent>;
rpcTransportOptions.namespace satisfies DurableObjectNamespace<AuthMcpAgent>;

// ============================================
// NEGATIVE TESTS - non-object props stay rejected
// ============================================

// @ts-expect-error — a primitive is not a props bag
declare class BadPropsAgent extends Agent<typeof env, unknown, string> {}

getAgentByName(agentNamespace, "instance", {
  // @ts-expect-error — a primitive is not a props bag
  props: "not-an-object"
});

// Silence unused-declaration noise; this file only exists to typecheck.
export type {};
