import { getAgentByName, routeAgentRequest } from "agents";
import { createWorkersAI } from "workers-ai-provider";
import { Think } from "@cloudflare/think";
import {
  ThinkMessengerStateAgent,
  type ThinkMessengers
} from "@cloudflare/think/messengers";
import telegramMessenger from "@cloudflare/think/messengers/telegram";

export { ThinkMessengerStateAgent };

type Env = {
  AI: Ai;
  SupportAgent: DurableObjectNamespace<SupportAgent>;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_BOT_USERNAME?: string;
  TELEGRAM_WEBHOOK_SECRET_TOKEN: string;
};

const AGENT_NAME = "default";
const TELEGRAM_WEBHOOK_PATH = "/messengers/telegram/webhook";

export type SetupInfo = {
  agentName: string;
  webhookPath: string;
};

export type TelegramWebhookSetupResult = {
  ok: boolean;
  result: unknown;
  webhookUrl: string;
};

export class SupportAgent extends Think<Env> {
  override getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.7-code"
    );
  }

  override getSystemPrompt() {
    return [
      "You are a concise support assistant replying from a Telegram chat.",
      "Keep replies friendly, practical, and short enough for chat."
    ].join("\n");
  }

  override getMessengers(): ThinkMessengers {
    return {
      telegram: telegramMessenger({
        token: this.env.TELEGRAM_BOT_TOKEN,
        userName: this.env.TELEGRAM_BOT_USERNAME ?? "think_chat_sdk_bot",
        secretToken: this.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
        conversation: "self",
        respondTo: ["direct-message", "mention"]
      })
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) {
      return agentResponse;
    }

    const url = new URL(request.url);
    const agent = await getAgentByName(env.SupportAgent, AGENT_NAME);

    if (url.pathname === TELEGRAM_WEBHOOK_PATH) {
      return agent.fetch(request);
    }

    if (
      request.method === "POST" &&
      url.pathname === "/setup/telegram-webhook"
    ) {
      return setupTelegramWebhook(request, env);
    }

    if (request.method === "GET" && url.pathname === "/setup/info") {
      return Response.json({
        agentName: AGENT_NAME,
        webhookPath: TELEGRAM_WEBHOOK_PATH
      } satisfies SetupInfo);
    }

    return Response.json({
      name: "think-chat-sdk-example",
      routes: {
        webhook: TELEGRAM_WEBHOOK_PATH,
        setup: "POST /setup/telegram-webhook"
      }
    });
  }
};

export async function setupTelegramWebhook(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const webhookUrl = `${url.origin}${TELEGRAM_WEBHOOK_PATH}`;
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`,
    {
      body: JSON.stringify({
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: true,
        secret_token: env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
        url: webhookUrl
      }),
      headers: {
        "content-type": "application/json"
      },
      method: "POST"
    }
  );

  const result = (await response.json()) as unknown;
  return Response.json(
    {
      ok: response.ok,
      result,
      webhookUrl
    } satisfies TelegramWebhookSetupResult,
    { status: response.ok ? 200 : 502 }
  );
}
