// Chat with the AI SDK agent from a terminal: pnpm tui [room]
import { runAgentTUI } from "@ai-sdk/tui";
import { WebChannelChatTransport } from "agents/experimental/channels/web/ai-sdk";
import { WebChannelClient } from "agents/experimental/channels/web/client";

const room = process.argv[2] ?? "default";
const origin = process.env.AGENT_ORIGIN ?? "ws://localhost:5173";
const me = `terminal-${crypto.randomUUID().slice(0, 6)}`;
const client = new WebChannelClient(
  `${origin}/channels/ai-sdk/${room}?as=${me}`
);

await runAgentTUI({
  title: `Channels: AI SDK agent (${room})`,
  reasoning: "full",
  tools: "full",
  transport: new WebChannelChatTransport(client, {
    tools: {
      getLocation: () => ({
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
      })
    }
  })
});
client.close();
