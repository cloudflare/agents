import {
  ChannelGateway,
  consumeChunks,
  routes,
  type Channel,
  type ResponseChunk,
  type ChannelMessageSurface,
  type DeliveryResult
} from "agents/experimental/channels";
import { createSendMessageTool, toResponseChunks } from "agents/harness/ai-sdk";
import { email } from "agents/experimental/channels/email";
import { slack } from "agents/experimental/channels/slack";
import { telegram } from "agents/experimental/channels/telegram";

const channel: Channel = {
  deliver: async () => ({ status: "delivered" })
};
const gateway = new ChannelGateway({
  channels: { test: channel },
  agent: () => ({
    receive: async () => undefined,
    fetch: async () => new Response()
  })
});
const surface: ChannelMessageSurface = {
  channelKey: "test",
  version: 1,
  address: "recipient",
  label: "Test recipient"
};

gateway.deliver(surface, {
  markdown: "hello"
}) satisfies Promise<DeliveryResult>;
gateway.stream(
  surface,
  new ReadableStream<ResponseChunk>()
) satisfies Promise<DeliveryResult>;
consumeChunks(new ReadableStream<string>(), {
  onChunk() {},
  onFinish: () => "done"
}) satisfies Promise<string>;
routes.perThread;
createSendMessageTool;
toResponseChunks;
email;
slack;
telegram;
