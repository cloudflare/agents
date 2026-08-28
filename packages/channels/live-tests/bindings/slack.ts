import { slack } from "../../src/adapters/slack";
import { ChannelHost } from "../../src/host";
import type { ChannelMessageSurface } from "../../src/surface";
import {
  requiredEnv,
  type LiveDeliveryBinding,
  type ObservedMessage
} from "../binding";

type SlackMessage = {
  ts: string;
  text: string;
  reply_count?: number;
  subtype?: string;
};
type SlackResponse = {
  ok: boolean;
  error?: string;
  ts?: string;
  team_id?: string;
  user_id?: string;
  members?: string[];
  messages?: SlackMessage[];
};

async function slackApi(
  token: string,
  method: string,
  values: Record<string, string>
): Promise<SlackResponse> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(values)
  });
  const payload = (await response.json()) as SlackResponse;
  if (!payload.ok) throw new Error(`Slack ${method}: ${payload.error}`);
  return payload;
}

function createSlackBinding(threaded: boolean): LiveDeliveryBinding {
  const token = requiredEnv("CHANNELS_LIVE_SLACK_BOT_TOKEN");
  const channelId = requiredEnv("CHANNELS_LIVE_SLACK_CHANNEL_ID");
  const channel = slack({ botToken: token });
  const host = new ChannelHost({ channels: { slack: channel } });
  let anchorTs: string | undefined;
  let surface: ChannelMessageSurface = {
    channelKey: "slack",
    version: 1,
    address: { channelId },
    label: `Slack · ${channelId}`
  };

  async function messages(): Promise<SlackMessage[]> {
    const result = await slackApi(token, "conversations.history", {
      channel: channelId,
      limit: "100"
    });
    const history = result.messages ?? [];
    const observed: SlackMessage[] = [];
    for (const message of history) {
      observed.push(message);
      if (!message.reply_count) continue;
      const thread = await slackApi(token, "conversations.replies", {
        channel: channelId,
        ts: message.ts,
        limit: "100"
      });
      observed.push(
        ...(thread.messages ?? []).filter((reply) => reply.ts !== message.ts)
      );
    }
    return observed;
  }

  async function clear(): Promise<void> {
    // Replies must be deleted before their parent. Slack may retain thread
    // tombstones after deletion; those are not messages the bot can delete.
    for (const message of (await messages()).reverse()) {
      if (message.subtype === "message_deleted") continue;
      try {
        await slackApi(token, "chat.delete", {
          channel: channelId,
          ts: message.ts
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("message_not_found")
        ) {
          continue;
        }
        throw error;
      }
    }
  }

  return {
    name: threaded ? "slack-thread" : "slack",
    host,
    get surface() {
      return surface;
    },
    destination: threaded
      ? `Slack thread in channel ${channelId}`
      : `Slack channel ${channelId}`,
    async open() {
      await clear();
      if (!threaded) return;

      // Native channel streaming needs a thread and the intended reader.
      const identity = await slackApi(token, "auth.test", {});
      const members = await slackApi(token, "conversations.members", {
        channel: channelId,
        limit: "100"
      });
      const recipientUserId = (members.members ?? []).find(
        (member) => member !== identity.user_id
      );
      if (!recipientUserId) {
        throw new Error(
          `Slack channel ${channelId} has no member besides this bot to stream to`
        );
      }
      const anchor = await slackApi(token, "chat.postMessage", {
        channel: channelId,
        text: "Cloudflare Channels live streaming thread."
      });
      anchorTs = anchor.ts;
      surface = {
        ...surface,
        address: {
          channelId,
          threadTs: anchorTs!,
          recipientUserId,
          recipientTeamId: identity.team_id!
        }
      };
    },
    clear,
    async read(): Promise<ObservedMessage[]> {
      return (await messages())
        .filter((message) => message.ts !== anchorTs)
        .map(({ text }) => ({ text }));
    }
  };
}

/** A top-level Slack channel destination. Streams collect and deliver once. */
export function slackBinding(): LiveDeliveryBinding {
  return createSlackBinding(false);
}

/** A Slack thread destination that exercises Slack's native streaming API. */
export function slackThreadBinding(): LiveDeliveryBinding {
  return createSlackBinding(true);
}
