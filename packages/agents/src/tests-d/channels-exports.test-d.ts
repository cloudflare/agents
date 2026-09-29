import {
  ChannelHost,
  consumeChunks,
  fallback,
  fanout,
  routes,
  type Channel,
  type ChannelChunk,
  type ChannelMessageSurface,
  type DeliveryResult
} from "agents/channels";
import { createSendMessageTool, toChannelChunks } from "agents/channels/ai-sdk";
import { email } from "agents/channels/email";
import { slack } from "agents/channels/slack";
import { createSendMessageTool as createTanStackSendMessageTool } from "agents/channels/tanstack-ai";
import { telegram } from "agents/channels/telegram";
import { browserVoice } from "agents/channels/voice";

const channel: Channel = {
  deliver: async () => ({ status: "delivered" })
};
const host = new ChannelHost({ channels: { test: channel } });
const surface: ChannelMessageSurface = {
  channelKey: "test",
  version: 1,
  address: "recipient",
  label: "Test recipient"
};

host.deliver(surface, { markdown: "hello" }) satisfies Promise<DeliveryResult>;
host.stream(
  surface,
  new ReadableStream<ChannelChunk>()
) satisfies Promise<DeliveryResult>;
consumeChunks(new ReadableStream<string>(), {
  onChunk() {},
  onFinish: () => "done"
}) satisfies Promise<string>;
fallback([surface]) satisfies ChannelMessageSurface;
fanout([surface]) satisfies ChannelMessageSurface;
routes.perThread;
createSendMessageTool;
toChannelChunks;
createTanStackSendMessageTool;
email;
slack;
telegram;
browserVoice;
