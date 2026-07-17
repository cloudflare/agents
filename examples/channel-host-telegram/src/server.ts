import { createTelegramAdapter } from "@chat-adapter/telegram";
import type { ThinkChannels } from "@cloudflare/think";
import { decodeIngestStream, Think } from "@cloudflare/think";
import { getAgentByName } from "agents";
import { Chat } from "chat";
import { createCloudflareState } from "chat-state-cloudflare-do";

// The Chat SDK's state lives in its OWN Durable Object — no Think involved.
export { ChatStateDO } from "chat-state-cloudflare-do";

const WEBHOOK_PATH = "/webhooks/telegram";

// ─────────────────────────────────────────────────────────────────────────────
// The AGENT: a Durable Object with zero transport code. It does not know
// Telegram exists. One instance per Telegram thread gets its own persistent
// transcript. The host reaches it through Workers RPC.
// ─────────────────────────────────────────────────────────────────────────────
export class HostedAgent extends Think<Env> {
  getModel() {
    return "@cf/moonshotai/kimi-k2.7-code";
  }

  configureChannels(): ThinkChannels {
    return {
      telegram: {
        instructions:
          "You are replying inside a Telegram chat. Be concise and direct. Plain text only, no markdown tables or headers."
      }
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The HOST: a worker-owned Chat SDK bot. It owns the Telegram connection,
// webhook verification, threading/dedupe state (in ChatStateDO), and the
// command surface. The agent is a callee it invokes for real messages.
// ─────────────────────────────────────────────────────────────────────────────

function safeAgentName(threadId: string): string {
  return threadId.replace(/[^A-Za-z0-9_-]+/g, "-") || "default";
}

/** Ask the agent for a turn over native Workers RPC. */
async function* askAgent(
  env: Env,
  threadId: string,
  text: string
): AsyncIterable<string> {
  const agent = await getAgentByName(env.HostedAgent, safeAgentName(threadId));
  const stream = await agent.ingest({
    channelId: "telegram",
    text
  });
  // Buffered alternative: const reply = await collectIngestReply(stream);
  for await (const event of decodeIngestStream(stream)) {
    if (event.type === "delta") yield event.text;
    if (event.type === "error") throw new Error(event.message);
  }
}

function createBot(env: Env) {
  const userName = env.TELEGRAM_BOT_USERNAME ?? "channel_host_demo_bot";
  const chat = new Chat({
    adapters: {
      telegram: createTelegramAdapter({
        botToken: env.TELEGRAM_BOT_TOKEN,
        mode: "webhook",
        secretToken: env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
        userName
      })
    },
    state: createCloudflareState({ namespace: env.CHAT_STATE }),
    userName
  });

  // Host-owned commands. The adapter parses `/commands` out of the update
  // stream and routes them here — they never become messages, never wake the
  // agent DO, never run a model turn.
  chat.onSlashCommand(async (event) => {
    switch (event.command) {
      case "/help":
        await event.channel.post(
          "Commands: /help, /whoami. Anything else goes to the AI agent."
        );
        return;
      case "/whoami":
        await event.channel.post(
          `channel "${event.channel.id}" -> dedicated agent instance "${safeAgentName(event.channel.id)}"`
        );
        return;
      default:
        await event.channel.post(
          `Unknown command ${event.command}. The agent never sees slash commands.`
        );
    }
  });

  // Real messages stream from the agent straight into Telegram (post+edit).
  const respond = async (thread: { id: string; post: Poster }, text?: string) =>
    text?.trim() && thread.post(askAgent(env, thread.id, text.trim()));

  chat.onDirectMessage(async (thread, message) => {
    await respond(thread, message.text);
  });
  chat.onNewMention(async (thread, message) => {
    await thread.subscribe();
    await respond(thread, message.text);
  });
  chat.onSubscribedMessage(async (thread, message) => {
    await respond(thread, message.text);
  });

  return chat;
}

type Poster = (text: string | AsyncIterable<string>) => Promise<unknown>;

/** One-time (idempotent) webhook registration: GET /setup/telegram */
async function setupWebhook(request: Request, env: Env): Promise<Response> {
  const origin = new URL(request.url).origin;
  const webhookUrl = `${origin}${WEBHOOK_PATH}`;
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
        allowed_updates: ["message"]
      })
    }
  );
  const result = (await response.json()) as {
    ok: boolean;
    description?: string;
  };
  return Response.json({ webhookUrl, ...result });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === WEBHOOK_PATH && request.method === "POST") {
      // The adapter verifies Telegram's secret token itself (secretToken in
      // its config), so the host adds no verification code of its own.
      const bot = createBot(env);
      return bot.webhooks.telegram(request, {
        waitUntil: (promise) => ctx.waitUntil(promise)
      });
    }
    if (url.pathname === "/setup/telegram") {
      return setupWebhook(request, env);
    }
    // The agent has no public transport route. The host is the only door.
    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
