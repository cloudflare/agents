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
  CHAT_REQUEST_CANCEL: "cf_agent_chat_request_cancel"
} as const;
