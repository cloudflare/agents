import { slack } from "../../src/adapters/slack";
import type { ChannelMessageSurface } from "../../src/surface";
import {
  requiredEnv,
  type LiveDeliveryBinding,
  type ObservedMessage
} from "../binding";

type SlackMessage = { ts: string; text: string };
type SlackResponse = {
  ok: boolean;
  error?: string;
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

export function slackBinding(): LiveDeliveryBinding {
  const token = requiredEnv("CHANNELS_LIVE_SLACK_BOT_TOKEN");
  const channelId = requiredEnv("CHANNELS_LIVE_SLACK_CHANNEL_ID");
  const channel = slack({ botToken: token });
  const surface: ChannelMessageSurface = {
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
    return result.messages ?? [];
  }

  return {
    name: "slack",
    destination: `Slack channel ${channelId}`,
    async clear() {
      for (const message of await messages()) {
        await slackApi(token, "chat.delete", {
          channel: channelId,
          ts: message.ts
        });
      }
    },
    async deliver(text) {
      return await channel.deliver!(surface, { markdown: text });
    },
    async read(): Promise<ObservedMessage[]> {
      return (await messages()).map(({ text }) => ({ text }));
    }
  };
}
