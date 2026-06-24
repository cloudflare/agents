/**
 * Wire protocol message type constants for the cf_agent_chat_* protocol.
 *
 * These are the string values used on the wire between agent servers and
 * clients. Both @cloudflare/ai-chat (via its MessageType enum) and
 * @cloudflare/think use these values.
 */
export const CHAT_MESSAGE_TYPES = {
  CHAT_MESSAGES: "cf_agent_chat_messages",
  USE_CHAT_REQUEST: "cf_agent_use_chat_request",
  USE_CHAT_RESPONSE: "cf_agent_use_chat_response",
  CHAT_CLEAR: "cf_agent_chat_clear",
  CHAT_REQUEST_CANCEL: "cf_agent_chat_request_cancel",
  STREAM_RESUMING: "cf_agent_stream_resuming",
  STREAM_RESUME_ACK: "cf_agent_stream_resume_ack",
  STREAM_RESUME_REQUEST: "cf_agent_stream_resume_request",
  STREAM_RESUME_NONE: "cf_agent_stream_resume_none",
  // Server→client: a turn has been accepted but its resumable stream has not
  // started yet (queued, debouncing, waiting on MCP setup, or running async
  // work in `onChatMessage`). Sent in response to a resume request (or on
  // connect) so a reconnecting/re-mounting client keeps its expectation instead
  // of resolving its resume probe to "no stream" and then false-timing-out the
  // turn. Resolved by a later `STREAM_RESUMING` (stream started) or
  // `STREAM_RESUME_NONE` (turn settled without streaming). Backward-compatible —
  // clients that don't understand it ignore it. See issue #1784.
  STREAM_PENDING: "cf_agent_stream_pending",
  TOOL_RESULT: "cf_agent_tool_result",
  TOOL_APPROVAL: "cf_agent_tool_approval",
  MESSAGE_UPDATED: "cf_agent_message_updated",
  // Server→client: a durable chat turn is being recovered (interrupted by a
  // deploy/eviction or a stream-stall watchdog abort and now resuming). Sent
  // when a recovery continuation is scheduled and cleared on every terminal
  // outcome; `@cloudflare/think` also replays it on connect so a client that
  // joins mid-recovery learns it. Purely a progress hint — backward-compatible
  // (clients that don't understand it ignore it). See issue #1620.
  CHAT_RECOVERING: "cf_agent_chat_recovering"
} as const;
