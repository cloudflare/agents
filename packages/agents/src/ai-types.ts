import { MessageType as AgentsMessageType } from "./types";
import {
  MessageType as AiChatMessageType,
  type IncomingMessage,
  type OutgoingMessage
} from "@cloudflare/ai-chat/types";

export type { IncomingMessage, OutgoingMessage };
export const MessageType = {
  ...AiChatMessageType,
  ...AgentsMessageType
};

console.log(
  "All the AI Chat related modules are now in @cloudflare/ai-chat. This module is deprecated and will be removed in the next major version."
);
