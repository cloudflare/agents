/**
 * Constraint for agent `Props` type parameters and prop-bag options.
 *
 * Interfaces do not get implicit index signatures in TypeScript, so a
 * `Record<string, unknown>` bound rejects user-defined interfaces with
 * "Index signature for type 'string' is missing". An index signature over
 * `any` is the one record shape every interface satisfies, so props can be
 * typed with plain interfaces. Use this alias for every props bound and
 * user-facing prop-bag option; keep generic *defaults* at
 * `Record<string, unknown>` so untyped usage still reads props values as
 * `unknown`.
 */
// oxlint-disable-next-line typescript/no-explicit-any
export type AgentProps = Record<string, any>;

/**
 * Enum for message types to improve type safety and maintainability
 */
export enum MessageType {
  CF_AGENT_MCP_SERVERS = "cf_agent_mcp_servers",
  CF_MCP_AGENT_EVENT = "cf_mcp_agent_event",
  CF_AGENT_STATE = "cf_agent_state",
  CF_AGENT_STATE_ERROR = "cf_agent_state_error",
  CF_AGENT_IDENTITY = "cf_agent_identity",
  CF_AGENT_SESSION = "cf_agent_session",
  CF_AGENT_SESSION_ERROR = "cf_agent_session_error",
  RPC = "rpc"
}
