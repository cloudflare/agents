/**
 * Parse Slack event payloads into normalized InboundEvent format.
 *
 * Handles the Events API payload structure:
 *   { type: "event_callback", event: { type: "message", ... } }
 */

import type {
  InboundEvent,
  NormalizedMessage,
  SlackChannelRef
} from "../../types";

/**
 * Checks if a Slack payload is a URL verification challenge.
 * Returns the challenge string if so, or undefined.
 */
export function getSlackChallenge(
  payload: Record<string, unknown>
): string | undefined {
  if (payload.type === "url_verification") {
    return payload.challenge as string;
  }
  return undefined;
}

/**
 * Parse a Slack Events API payload (already JSON-parsed) into an InboundEvent.
 */
export function parseSlackEvent(
  payload: Record<string, unknown>
): InboundEvent {
  if (payload.type === "url_verification") {
    return {
      type: "unknown",
      platform: "slack",
      channel: { platform: "slack", channelId: "" },
      raw: payload
    };
  }

  if (payload.type === "event_callback") {
    const event = payload.event as Record<string, unknown> | undefined;
    if (!event) {
      return {
        type: "unknown",
        platform: "slack",
        channel: { platform: "slack", channelId: "" },
        raw: payload
      };
    }
    return parseEventCallback(event, payload);
  }

  // Interactive payloads (block actions, slash commands) come as
  // form-encoded with a "payload" field. The caller should JSON.parse
  // that field before passing it here.
  if (payload.type === "block_actions") {
    return parseBlockAction(payload);
  }

  if (payload.command) {
    return parseSlashCommand(payload);
  }

  return {
    type: "unknown",
    platform: "slack",
    channel: { platform: "slack", channelId: "" },
    raw: payload
  };
}

function parseEventCallback(
  event: Record<string, unknown>,
  envelope: Record<string, unknown>
): InboundEvent {
  const eventType = event.type as string;
  const channelId = (event.channel as string) ?? "";
  const threadTs = event.thread_ts as string | undefined;
  const teamId = envelope.team_id as string | undefined;

  const channel: SlackChannelRef = {
    platform: "slack",
    channelId,
    threadTs,
    teamId
  };

  if (eventType === "message" || eventType === "app_mention") {
    const message = parseSlackMessage(event);
    return {
      type: "message",
      platform: "slack",
      channel,
      message,
      raw: envelope
    };
  }

  if (eventType === "reaction_added" || eventType === "reaction_removed") {
    const item = event.item as Record<string, unknown> | undefined;
    return {
      type: "reaction",
      platform: "slack",
      channel: {
        platform: "slack",
        channelId: (item?.channel as string) ?? channelId,
        teamId
      },
      reaction: {
        emoji: event.reaction as string,
        added: eventType === "reaction_added",
        userId: event.user as string,
        messageId: (item?.ts as string) ?? ""
      },
      raw: envelope
    };
  }

  if (eventType === "member_joined_channel") {
    return {
      type: "member_joined",
      platform: "slack",
      channel,
      raw: envelope
    };
  }

  return {
    type: "unknown",
    platform: "slack",
    channel,
    raw: envelope
  };
}

function parseBlockAction(payload: Record<string, unknown>): InboundEvent {
  const actions = payload.actions as Array<Record<string, unknown>>;
  const action = actions?.[0];
  const channelObj = payload.channel as Record<string, unknown> | undefined;
  const user = payload.user as Record<string, unknown> | undefined;

  return {
    type: "interaction",
    platform: "slack",
    channel: {
      platform: "slack",
      channelId: (channelObj?.id as string) ?? ""
    },
    interaction: {
      actionId: (action?.action_id as string) ?? "",
      value:
        (action?.value as string) ??
        ((action?.selected_option as Record<string, unknown>)?.value as
          | string
          | undefined),
      userId: (user?.id as string) ?? "",
      triggerId: payload.trigger_id as string | undefined
    },
    raw: payload
  };
}

function parseSlashCommand(payload: Record<string, unknown>): InboundEvent {
  return {
    type: "command",
    platform: "slack",
    channel: {
      platform: "slack",
      channelId: (payload.channel_id as string) ?? "",
      teamId: payload.team_id as string | undefined
    },
    command: {
      command: payload.command as string,
      text: (payload.text as string) ?? "",
      userId: (payload.user_id as string) ?? ""
    },
    raw: payload
  };
}

function parseSlackMessage(event: Record<string, unknown>): NormalizedMessage {
  const subtype = event.subtype as string | undefined;

  // bot_message subtype has a different author shape
  const isBot =
    subtype === "bot_message" || (event.bot_id as string | undefined) != null;

  return {
    id: (event.ts as string) ?? "",
    text: (event.text as string) ?? "",
    author: {
      id: (event.user as string) ?? (event.bot_id as string) ?? "",
      name: (event.username as string) ?? (event.user as string) ?? "unknown",
      isBot
    },
    timestamp: parseSlackTs(event.ts as string),
    isMention:
      (event.type as string) === "app_mention" ||
      ((event.text as string) ?? "").includes("<@"),
    replyToMessageId: event.thread_ts as string | undefined
  };
}

function parseSlackTs(ts: string | undefined): number {
  if (!ts) return Date.now();
  const seconds = parseFloat(ts);
  return Math.floor(seconds * 1000);
}
