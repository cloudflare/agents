// Durable Object exports — wrangler needs these at the top level
export { ChatAgent } from "./agent";
export { ChatStateDO } from "chat-state-cloudflare-do";

import { createBot } from "./bot";

let bot: ReturnType<typeof createBot> | null = null;

function getBot(env: Env) {
  if (!bot) bot = createBot(env);
  return bot;
}

// How long the Gateway WebSocket stays open per cron invocation
const GATEWAY_DURATION_MS = 2 * 60 * 1000;

export default {
  // HTTP entry: Discord Interactions webhook (slash commands, button clicks)
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/webhooks/discord" && request.method === "POST") {
      return getBot(env).webhooks.discord(request, {
        waitUntil: ctx.waitUntil.bind(ctx)
      });
    }

    if (url.pathname === "/" && request.method === "GET") {
      return new Response("OK");
    }

    return new Response("Not Found", { status: 404 });
  },

  // Cron entry: opens a Discord Gateway connection to receive @mentions
  async scheduled(_controller, env, ctx): Promise<void> {
    const bot = getBot(env);
    await bot.initialize();

    const discord = bot.getAdapter("discord");
    await discord.startGatewayListener(
      { waitUntil: ctx.waitUntil.bind(ctx) },
      GATEWAY_DURATION_MS
    );
  }
} satisfies ExportedHandler<Env>;
