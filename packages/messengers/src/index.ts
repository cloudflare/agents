// Core types
export type {
  ChannelRef,
  SlackChannelRef,
  TelegramChannelRef,
  GenericChannelRef,
  Author,
  Attachment,
  NormalizedMessage,
  InboundEvent,
  MessageEvent,
  ReactionInboundEvent,
  InteractionInboundEvent,
  CommandInboundEvent,
  MemberJoinedEvent,
  UnknownEvent,
  ReactionEvent,
  InteractionEvent,
  CommandEvent,
  Button,
  MessageBlock,
  OutboundMessage,
  SentMessage,
  PlatformCapabilities
} from "./types";

// Adapter interface and utilities
export type { MessengerAdapter } from "./adapter";
export { renderToMarkdown } from "./adapter";

// Message splitting
export { splitMessage } from "./message-splitter";

// Stream utilities
export { teeAsyncIterable } from "./tee";

// Adapters
export { SlackMessenger, type SlackMessengerOptions } from "./adapters/slack";
export {
  TelegramMessenger,
  type TelegramMessengerOptions
} from "./adapters/telegram";
export {
  GoogleChatMessenger,
  type GoogleChatMessengerOptions
} from "./adapters/google-chat";
