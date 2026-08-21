import type {
  ChannelIdentity,
  ChannelMessageSurface,
  DeliveryResult,
  UserIdentity
} from "@cloudflare/channels";

/** The Durable Object name of the single conversation-and-user directory. */
export const DIRECTORY_NAME = "support";

export type ReceivedMessage = {
  id: string;
  direction: "received";
  markdown: string;
  createdAt: string;
  /** The Channel this message arrived through. */
  channelKey: string;
  /** Who sent it. `identity` is the reusable, linkable Channel identity. */
  author?: { name?: string; identity?: ChannelIdentity };
};

export type SentMessage = {
  id: string;
  direction: "sent";
  markdown: string;
  createdAt: string;
  destination: { channelKey: string; label: string };
  /** Exactly what the Channel reported for this one attempt. */
  delivery: DeliveryResult;
  /** Present when this message asked for a provider-native approval. */
  approval?: {
    interactionId: string;
    decision: "approve" | "reject" | null;
    decidedAt: string | null;
  };
};

export type Message = ReceivedMessage | SentMessage;

export type ConversationSummary = {
  /** The route its Channel chose, which is also its Durable Object name. */
  id: string;
  title: string;
  preview: string;
  /**
   * The Channel the most recent message used. A conversation is a place, not a
   * channel: once identities are linked, several Channels feed the same one.
   */
  lastChannelKey: string;
  updatedAt: string;
  closedAt: string | null;
  messageCount: number;
  /** Every reusable identity seen in this conversation. */
  identities: ChannelIdentity[];
};

export type ConversationSnapshot = ConversationSummary & {
  messages: Message[];
};

export type ConversationPage = {
  conversation: ConversationSnapshot;
  /** One conversation belongs to at most one user, who may have many identities. */
  user: UserIdentity | null;
  targets: ChannelMessageSurface[];
};

export type UserPage = {
  user: UserIdentity;
  conversations: ConversationSummary[];
};

export type DirectorySnapshot = {
  conversations: ConversationSummary[];
  users: UserIdentity[];
};
