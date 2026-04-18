/**
 * Parse Google Chat interaction events into normalized InboundEvent format.
 *
 * Google Chat sends events with a `type` field:
 *   - MESSAGE: user sent a message or @mentioned the bot
 *   - ADDED_TO_SPACE: bot was added to a space
 *   - REMOVED_FROM_SPACE: bot was removed
 *   - CARD_CLICKED: user clicked a button in a card
 */

import type {
  InboundEvent,
  NormalizedMessage,
  GenericChannelRef
} from "../../types";

export interface GoogleChatEvent {
  type: string;
  eventTime?: string;
  token?: string;
  threadKey?: string;
  message?: GoogleChatMessage;
  user?: GoogleChatUser;
  space?: GoogleChatSpace;
  action?: {
    actionMethodName?: string;
    parameters?: Array<{ key: string; value: string }>;
  };
  common?: {
    invokedFunction?: string;
    formInputs?: Record<string, unknown>;
  };
}

interface GoogleChatMessage {
  name?: string;
  text?: string;
  sender?: GoogleChatUser;
  createTime?: string;
  thread?: { name?: string; threadKey?: string };
  argumentText?: string;
  annotations?: Array<{
    type?: string;
    startIndex?: number;
    length?: number;
    userMention?: { user?: GoogleChatUser; type?: string };
  }>;
  attachment?: Array<{
    name?: string;
    contentName?: string;
    contentType?: string;
    driveDataRef?: { driveFileId?: string };
    downloadUri?: string;
  }>;
}

interface GoogleChatUser {
  name?: string;
  displayName?: string;
  email?: string;
  type?: string;
  domainId?: string;
}

interface GoogleChatSpace {
  name?: string;
  type?: string;
  displayName?: string;
  singleUserBotDm?: boolean;
}

export interface GoogleChatChannelRef extends GenericChannelRef {
  platform: "google-chat";
  spaceName: string;
  threadName?: string;
}

export function parseGoogleChatEvent(event: GoogleChatEvent): InboundEvent {
  const spaceName = event.space?.name ?? "";
  const threadName = event.message?.thread?.name;

  const channel: GoogleChatChannelRef = {
    platform: "google-chat",
    spaceName,
    threadName
  };

  switch (event.type) {
    case "MESSAGE":
      return {
        type: "message",
        platform: "google-chat",
        channel,
        message: parseMessage(event),
        raw: event
      };

    case "CARD_CLICKED": {
      const actionName =
        event.action?.actionMethodName ?? event.common?.invokedFunction ?? "";
      const params = event.action?.parameters ?? [];
      const value = params.length > 0 ? params[0].value : undefined;

      return {
        type: "interaction",
        platform: "google-chat",
        channel,
        interaction: {
          actionId: actionName,
          value,
          userId: event.user?.name ?? ""
        },
        raw: event
      };
    }

    case "ADDED_TO_SPACE":
      return {
        type: "member_joined",
        platform: "google-chat",
        channel,
        raw: event
      };

    case "REMOVED_FROM_SPACE":
    default:
      return {
        type: "unknown",
        platform: "google-chat",
        channel,
        raw: event
      };
  }
}

function parseMessage(event: GoogleChatEvent): NormalizedMessage {
  const msg = event.message;
  const sender = msg?.sender ?? event.user;

  const text = msg?.argumentText ?? msg?.text ?? "";
  const hasMention =
    msg?.annotations?.some((a) => a.type === "USER_MENTION") ?? false;

  return {
    id: msg?.name ?? "",
    text,
    author: {
      id: sender?.name ?? "",
      name: sender?.displayName ?? sender?.email ?? "unknown",
      isBot: sender?.type === "BOT"
    },
    timestamp: msg?.createTime
      ? new Date(msg.createTime).getTime()
      : Date.now(),
    isMention: hasMention
  };
}
