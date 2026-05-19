import { createTelegramAdapter } from "@chat-adapter/telegram";
import { Agent, getAgentByName } from "agents";
import type {
  FiberContext,
  FiberRecoveryContext,
  FiberRecoveryResult,
  SubAgentStub
} from "agents";
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
const AI_REPLY_FIBER_NAME = "chat-sdk-messenger:ai-reply";
const EMPTY_AI_RESPONSE =
  "I couldn't produce a text response. Please try again.";
const INTERRUPTED_AI_RESPONSE =
  "Sorry, my reply was interrupted. Please send your message again if you'd like me to retry.";

export type AiReplyStage = "accepted" | "streaming" | "completed";

export type AiReplySnapshot = {
  type: typeof AI_REPLY_FIBER_NAME;
  stage: AiReplyStage;
  thread: unknown;
  message: unknown;
};

export function aiReplyRecoveryMode(
  snapshot: AiReplySnapshot
): "answer" | "apologize" | null {
  if (snapshot.stage === "accepted") {
    return "answer";
  }
  if (snapshot.stage === "streaming") {
    return "apologize";
  }
  return null;
}

export function aiReplyFailureMode(
  hasStreamedText: boolean
): "apologize" | "error" {
  return hasStreamedText ? "apologize" : "error";
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function parseAiReplySnapshot(snapshot: unknown): AiReplySnapshot | null {
  if (snapshot === null || typeof snapshot !== "object") {
    return null;
  }

  const candidate = snapshot as Partial<AiReplySnapshot>;
  if (
    candidate.type !== AI_REPLY_FIBER_NAME ||
    (candidate.stage !== "accepted" &&
      candidate.stage !== "streaming" &&
      candidate.stage !== "completed") ||
    candidate.thread === undefined ||
    candidate.message === undefined
  ) {
    return null;
  }

  return {
    type: AI_REPLY_FIBER_NAME,
    stage: candidate.stage,
    thread: candidate.thread,
    message: candidate.message
  };
}

function aiReplySnapshot(
  stage: AiReplyStage,
  thread: Thread,
  message: Message
): AiReplySnapshot {
  return {
    type: AI_REPLY_FIBER_NAME,
    stage,
    thread: thread.toJSON(),
    message: message.toJSON()
  };
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

  override async onFiberRecovered(
    ctx: FiberRecoveryContext
  ): Promise<void | FiberRecoveryResult> {
    if (ctx.name !== AI_REPLY_FIBER_NAME) {
      return;
    }

    const snapshot = parseAiReplySnapshot(ctx.snapshot);
    if (!snapshot) {
      return;
    }

    await this.recoverAiReply(snapshot);
    return { status: "completed" };
  }

  private async recoverAiReply(snapshot: AiReplySnapshot): Promise<void> {
    const bot = this.getBot();
    if (bot instanceof Error) {
      throw bot;
    }

    const restored = JSON.parse(JSON.stringify(snapshot), bot.reviver()) as {
      thread: Thread;
      message: Message;
    };
    const mode = aiReplyRecoveryMode(snapshot);
    if (mode === "answer") {
      await this.answerWithConversationAgent(restored.thread, restored.message);
      return;
    }

    if (mode === "apologize") {
      await restored.thread.post(INTERRUPTED_AI_RESPONSE);
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

      await this.enqueueConversationReply(thread, message);
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

      await this.enqueueConversationReply(thread, message);
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
        await this.enqueueConversationReply(thread, message);
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

    return bot.registerSingleton();
  }

  private async answerWithConversationAgent(
    thread: Thread,
    message: Message,
    fiber?: FiberContext
  ): Promise<void> {
    const callback = new TextStreamCallback();
    let agent: SubAgentStub<ConversationAgent> | undefined;
    fiber?.stash(aiReplySnapshot("streaming", thread, message));
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
      fiber?.stash(aiReplySnapshot("completed", thread, message));
    } catch (error) {
      callback.fail(error);
      await post.catch(() => undefined);
      if (aiReplyFailureMode(callback.hasText()) === "apologize") {
        await thread.post(INTERRUPTED_AI_RESPONSE).catch(() => undefined);
        fiber?.stash(aiReplySnapshot("completed", thread, message));
        return;
      }

      const errorMessage = toError(error).message;
      await thread.post({
        markdown: `Sorry, I couldn't answer that right now.\n\n${errorMessage}`
      });
      fiber?.stash(aiReplySnapshot("completed", thread, message));
    }
  }

  private async enqueueConversationReply(
    thread: Thread,
    message: Message
  ): Promise<void> {
    const result = await this.startFiber(
      AI_REPLY_FIBER_NAME,
      async (fiber: FiberContext) => {
        fiber.stash(aiReplySnapshot("accepted", thread, message));
        await this.answerWithConversationAgent(thread, message, fiber);
      },
      {
        idempotencyKey: `ai-reply:${thread.id}:${message.id}`,
        metadata: {
          provider: "telegram",
          threadId: thread.id,
          messageId: message.id
        },
        waitForCompletion: true
      }
    );

    if (result.accepted || result.status !== "interrupted") {
      return;
    }

    const snapshot = parseAiReplySnapshot(result.snapshot);
    if (snapshot) {
      await this.recoverAiReply(snapshot);
      await this.resolveFiber(result.fiberId, { status: "completed" });
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
