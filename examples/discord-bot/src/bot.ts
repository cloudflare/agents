import { Chat } from "chat";
import { createDiscordAdapter } from "@chat-adapter/discord";
import { createCloudflareState } from "chat-state-cloudflare-do";
import { registerHandlers } from "./handlers";
import type { ThreadState } from "./types";

export function createBot(env: Env) {
  const adapters = {
    discord: createDiscordAdapter({
      botToken: env.DISCORD_BOT_TOKEN,
      publicKey: env.DISCORD_PUBLIC_KEY,
      applicationId: env.DISCORD_APPLICATION_ID
    })
  };

  const bot = new Chat<typeof adapters, ThreadState>({
    userName: "sidekick",
    adapters,
    state: createCloudflareState({ namespace: env.CHAT_STATE }),
    streamingUpdateIntervalMs: 500,
    fallbackStreamingPlaceholderText: "Thinking..."
  });

  registerHandlers(bot, env);
  return bot;
}
