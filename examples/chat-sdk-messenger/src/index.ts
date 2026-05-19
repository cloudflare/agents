import { createTelegramAdapter } from "@chat-adapter/telegram";
import { Agent, getAgentByName } from "agents";
import type { SubAgentStub } from "agents";
import { Chat } from "chat";
import type { Message, Thread } from "chat";
import { APPROVE_ACTION_ID, REJECT_ACTION_ID } from "./demos";
import { ConversationAgent } from "./intelligence/conversation-agent";
import {
  conversationNameForThread,
  isMenuCommand,
  isResetCommand,
  shouldRouteToAi,
  toThinkUserMessage
} from "./intelligence/messages";
import { TextStreamCallback } from "./intelligence/stream-callback";
import {
  ASK_AGENT_ACTION_ID,
  DEMO_LOOKUP,
  MENU_IDS,
  postAskAgentInstructions,
  postMainMenu,
  postMenu
} from "./menu";
import { createAgentChatState } from "./state";

export { ConversationAgent } from "./intelligence/conversation-agent";
export { ChatStateAgent } from "./state";

const WEBHOOK_PATH = "/webhooks/telegram";
const DEFAULT_AGENT_NAME = "default";
const EMPTY_AI_RESPONSE =
  "I couldn't produce a text response. Please try again.";

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function setupErrorResponse(error: Error): Response {
  return new Response(
    `Chat SDK ingress Agent is not configured: ${error.message}`,
    {
      status: 500,
      headers: {
        "content-type": "text/plain; charset=utf-8"
      }
    }
  );
}

export function getIngressAgentName(_request: Request): string {
  return DEFAULT_AGENT_NAME;
}

export class ChatIngressAgent extends Agent {
  private bot?: Chat;
  private botStartupError?: Error;

  onStart(): void {
    try {
      this.bot = this.createBot();
      this.botStartupError = undefined;
    } catch (error) {
      this.bot = undefined;
      this.botStartupError = toError(error);
    }
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== WEBHOOK_PATH) {
      return new Response("Not found", { status: 404 });
    }

    const bot = this.getBot();
    if (bot instanceof Error) {
      return setupErrorResponse(bot);
    }

    return bot.webhooks.telegram(request, {
      waitUntil: (task: Promise<unknown>) => this.ctx.waitUntil(task)
    });
  }

  private getBot(): Chat | Error {
    if (this.bot) {
      return this.bot;
    }

    return (
      this.botStartupError ??
      new Error("Chat SDK runtime was not created during Agent startup")
    );
  }

  private createBot(): Chat {
    if (!this.env.TELEGRAM_BOT_TOKEN) {
      throw new Error("TELEGRAM_BOT_TOKEN is required");
    }

    const userName =
      this.env.TELEGRAM_BOT_USERNAME ?? "cloudflare_chat_sdk_bot";
    const telegram = createTelegramAdapter({
      botToken: this.env.TELEGRAM_BOT_TOKEN,
      mode: "webhook",
      secretToken: this.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
      userName
    });

    const bot = new Chat({
      userName,
      adapters: { telegram },
      state: createAgentChatState({
        parent: this,
        shardKey: (threadId) => threadId.split(":").slice(0, 2).join(":")
      }),
      concurrency: { strategy: "burst", debounceMs: 600 }
    });

    bot.onNewMention(async (thread, message) => {
      await thread.subscribe();
      if (isMenuCommand(message.text)) {
        await postMainMenu(thread);
        return;
      }

      await this.answerWithConversationAgent(thread, message);
    });

    bot.onDirectMessage(async (thread, message) => {
      if (isMenuCommand(message.text)) {
        await postMainMenu(thread);
        return;
      }

      if (isResetCommand(message.text)) {
        await this.resetConversation(thread);
        return;
      }

      await this.answerWithConversationAgent(thread, message);
    });

    bot.onSubscribedMessage(async (thread, message) => {
      if (isMenuCommand(message.text)) {
        await postMainMenu(thread);
        return;
      }

      if (isResetCommand(message.text)) {
        await this.resetConversation(thread);
        return;
      }

      if (this.shouldUseAi(message, thread)) {
        await this.answerWithConversationAgent(thread, message);
      }
    });

    bot.onAction(async (event) => {
      const thread = event.thread;
      if (!thread) {
        return;
      }

      if (event.actionId === ASK_AGENT_ACTION_ID) {
        await postAskAgentInstructions(thread);
        return;
      }

      if (MENU_IDS.has(event.actionId)) {
        await postMenu(thread, event.actionId);
        return;
      }

      const demo = DEMO_LOOKUP.get(event.actionId);
      if (demo) {
        await demo.run(thread);
        return;
      }

      if (
        event.actionId === APPROVE_ACTION_ID ||
        event.actionId === REJECT_ACTION_ID
      ) {
        const decision =
          event.actionId === APPROVE_ACTION_ID ? "approved" : "rejected";
        await event.adapter.editMessage(event.threadId, event.messageId, {
          markdown: `Deploy preview ${decision} by ${event.user.fullName || event.user.userName}.`
        });
        return;
      }

      await thread.post(`Unknown action: ${event.actionId}`);
    });

    return bot;
  }

  private async answerWithConversationAgent(
    thread: Thread,
    message: Message
  ): Promise<void> {
    const callback = new TextStreamCallback();
    let agent: SubAgentStub<ConversationAgent> | undefined;
    const post = thread
      .post(callback.stream())
      .catch(async (error: unknown) => {
        callback.fail(error);
        const requestId = callback.requestId();
        if (agent && requestId) {
          await agent
            .cancelChat(requestId, toError(error).message)
            .catch(() => undefined);
        }
        throw error;
      });

    try {
      await thread.startTyping("Thinking...");
      agent = await this.getConversationAgent(thread);
      await agent.chat(toThinkUserMessage(message), callback);
      callback.close();
      await post;
      if (!callback.hasText()) {
        await thread.post(EMPTY_AI_RESPONSE);
      }
    } catch (error) {
      callback.fail(error);
      await post.catch(() => undefined);
      if (callback.hasText()) {
        return;
      }

      const message = toError(error).message;
      await thread.post({
        markdown: `Sorry, I couldn't answer that right now.\n\n${message}`
      });
    }
  }

  private async resetConversation(thread: Thread): Promise<void> {
    const agent = await this.getConversationAgent(thread);
    await agent.resetConversation();
    await thread.post("I've reset this conversation.");
  }

  private getConversationAgent(
    thread: Thread
  ): Promise<SubAgentStub<ConversationAgent>> {
    return this.subAgent(ConversationAgent, conversationNameForThread(thread));
  }

  private shouldUseAi(message: Message, thread: Thread): boolean {
    return shouldRouteToAi({
      isDM: thread.isDM,
      isMention: message.isMention,
      text: message.text
    });
  }
}

function setupResponse(request: Request, env: Cloudflare.Env): Response {
  const url = new URL(request.url);
  const webhookUrl = `${url.origin}${WEBHOOK_PATH}`;
  const secretLine = `    "secret_token": "$TELEGRAM_WEBHOOK_SECRET_TOKEN"`;

  return new Response(
    [
      "Chat SDK messenger ingress Agent",
      "",
      `Webhook endpoint: ${webhookUrl}`,
      "",
      "Set the Telegram webhook with:",
      "",
      `curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d '{`,
      `    "url": "${webhookUrl}",`,
      secretLine,
      `  }'`,
      "",
      env.TELEGRAM_BOT_TOKEN
        ? "TELEGRAM_BOT_TOKEN is configured."
        : "TELEGRAM_BOT_TOKEN is not configured."
    ].join("\n"),
    {
      headers: {
        "content-type": "text/plain; charset=utf-8"
      }
    }
  );
}

export default {
  async fetch(
    request: Request,
    env: Cloudflare.Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return setupResponse(request, env);
    }

    if (request.method === "POST" && url.pathname === WEBHOOK_PATH) {
      const agent = await getAgentByName(
        env.ChatIngressAgent,
        getIngressAgentName(request)
      );
      return agent.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Cloudflare.Env>;
