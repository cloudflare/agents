export {
  useAgentChat,
  extractClientToolSchemas,
  detectToolsRequiringConfirmation,
  getToolPartState,
  getToolCallId,
  getToolInput,
  getToolOutput,
  getToolApproval,
  getAgentMessages
} from "agents/chat/react";

export type {
  JSONSchemaType,
  AITool,
  ClientToolSchema,
  UseAgentChatOptions,
  PrepareSendMessagesRequestOptions,
  PrepareSendMessagesRequestResult,
  OnToolCallCallback
} from "agents/chat/react";
