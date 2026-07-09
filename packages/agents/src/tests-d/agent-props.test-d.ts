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
import {
  Agent,
  getAgentByName,
  type AgentGetOptions,
  type AddRpcMcpServerOptions,
  type McpAgentProps
} from "..";
import { McpAgent } from "../mcp";

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

// addMcpServer's RPC options must accept interface-typed props, and the
// props type is derived from the target McpAgent's declared Props.
declare const mcpNamespace: DurableObjectNamespace<AuthMcpAgent>;
declare const authAgent: AuthAgent;
authAgent.addMcpServer("internal-tools", mcpNamespace, { props: authProps });

declare const derivedProps: McpAgentProps<AuthMcpAgent>;
derivedProps satisfies AuthProps;

// AddRpcMcpServerOptions must be instantiable with an interface.
declare const rpcServerOptions: AddRpcMcpServerOptions<AuthProps>;
rpcServerOptions.props satisfies AuthProps | undefined;

// ============================================
// NEGATIVE TESTS - non-object props stay rejected
// ============================================

// @ts-expect-error — a primitive is not a props bag
declare class BadPropsAgent extends Agent<typeof env, unknown, string> {}

getAgentByName(agentNamespace, "instance", {
  // @ts-expect-error — a primitive is not a props bag
  props: "not-an-object"
});

// @ts-expect-error — props must match the target McpAgent's declared Props
authAgent.addMcpServer("internal-tools", mcpNamespace, {
  props: { wrong: true }
});

// Silence unused-declaration noise; this file only exists to typecheck.
export type {};
