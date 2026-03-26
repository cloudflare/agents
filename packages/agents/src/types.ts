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
