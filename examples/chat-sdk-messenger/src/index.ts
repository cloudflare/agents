import { createTelegramAdapter } from "@chat-adapter/telegram";
import { Agent, callable, getAgentByName, routeAgentRequest } from "agents";
import type {
  FiberContext,
  FiberRecoveryContext,
  FiberRecoveryResult,
  SubAgentStub
} from "agents";
import { createChatSdkState } from "agents/chat-sdk";
import { Chat } from "chat";
import type { Message, Thread } from "chat";
import {
  adminConversationFromRow,
  adminReplyJobFromFiber,
  conversationTitle,
  messagePreview,
  providerFromThreadId,
  type AdminConversation,
  type AdminConversationRow,
  type AdminReplyJob,
  type AdminSetupInfo
} from "./admin/directory";
import { APPROVE_ACTION_ID, REJECT_ACTION_ID } from "./demos";
import { ConversationAgent } from "./intelligence/conversation-agent";
import {
  AI_REPLY_FIBER_NAME,
  EMPTY_AI_RESPONSE,
  INTERRUPTED_AI_RESPONSE,
  aiReplyFailureMode,
  aiReplyRecoveryMode,
  aiReplySnapshot,
  parseAiReplySnapshot,
  type AiReplySnapshot
} from "./intelligence/delivery";
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
import {
  TELEGRAM_STREAM_SOFT_LIMIT,
  WEBHOOK_PATH,
  isExpectedFinalEditNoop,
  setupTelegramWebhook,
  shardTelegramStateKey,
  splitTelegramMessageText
} from "./provider/telegram";

export { ConversationAgent } from "./intelligence/conversation-agent";
export { ChatSdkStateAgent } from "agents/chat-sdk";

export type {
  AdminConversation,
  AdminReplyJob,
  AdminSetupInfo
} from "./admin/directory";
export type { AiReplySnapshot } from "./intelligence/delivery";
export type { TelegramWebhookSetupResult } from "./provider/telegram";

const DEFAULT_AGENT_NAME = "default";

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
    this.ensureAdminSchema();
    try {
      this.bot = this.createBot();
      this.botStartupError = undefined;
    } catch (error) {
      this.bot = undefined;
      this.botStartupError = toError(error);
    }
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
      state: createChatSdkState({
        keyShard: (key) => shardTelegramStateKey(key, this.shardThread),
        shardKey: this.shardThread
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

  private ensureAdminSchema(): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS chat_admin_conversations (
        thread_id TEXT PRIMARY KEY,
        conversation_name TEXT NOT NULL,
        provider TEXT NOT NULL,
        title TEXT NOT NULL,
        last_message_preview TEXT,
        created_at INTEGER NOT NULL,
        last_message_at INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS idx_chat_admin_conversations_last_message
      ON chat_admin_conversations(last_message_at)
    `;
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

  override async onBeforeSubAgent(
    _request: Request,
    { className, name }: { className: string; name: string }
  ): Promise<Request | Response | void> {
    if (className !== ConversationAgent.name) {
      return new Response("Sub-agent not found", { status: 404 });
    }

    const rows = this.sql<{ thread_id: string }>`
      SELECT thread_id
      FROM chat_admin_conversations
      WHERE conversation_name = ${name}
      LIMIT 1
    `;
    if (!rows[0]) {
      return new Response(`Conversation "${name}" not found`, { status: 404 });
    }
  }

  @callable()
  getSetupInfo(): AdminSetupInfo {
    return {
      webhookPath: WEBHOOK_PATH,
      agentName: DEFAULT_AGENT_NAME,
      telegramConfigured: Boolean(this.env.TELEGRAM_BOT_TOKEN),
      telegramUserName:
        this.env.TELEGRAM_BOT_USERNAME ?? "cloudflare_chat_sdk_bot"
    };
  }

  @callable()
  listConversations(): AdminConversation[] {
    return this.readConversations();
  }

  @callable()
  inspectConversation(threadId: string): AdminConversation | null {
    return (
      this.readConversations().find(
        (conversation) => conversation.threadId === threadId
      ) ?? null
    );
  }

  @callable()
  async resetConversationByThread(threadId: string): Promise<void> {
    const conversation = this.readConversation(threadId);
    if (!conversation) {
      throw new Error(`Unknown conversation for thread ${threadId}`);
    }
    await (
      await this.subAgent(ConversationAgent, conversation.conversationName)
    ).resetConversation();
  }

  @callable()
  async listReplyJobs(threadId?: string): Promise<AdminReplyJob[]> {
    return (
      await this.listFibers({
        name: AI_REPLY_FIBER_NAME,
        limit: 100
      })
    )
      .map(adminReplyJobFromFiber)
      .filter((job) => threadId === undefined || job.threadId === threadId);
  }

  @callable()
  async cancelReplyJob(fiberId: string): Promise<boolean> {
    return this.cancelFiber(fiberId, "Cancelled from messenger admin UI");
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

  private readConversation(threadId: string): AdminConversation | null {
    const rows = this.sql<AdminConversationRow>`
      SELECT thread_id, conversation_name, provider, title,
             last_message_preview, created_at, last_message_at
      FROM chat_admin_conversations
      WHERE thread_id = ${threadId}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      return null;
    }

    return adminConversationFromRow(row);
  }

  private readConversations(): AdminConversation[] {
    const rows = this.sql<AdminConversationRow>`
      SELECT thread_id, conversation_name, provider, title,
             last_message_preview, created_at, last_message_at
      FROM chat_admin_conversations
      ORDER BY last_message_at DESC
      LIMIT 100
    `;

    return rows.map(adminConversationFromRow);
  }

  private async recordConversation(
    thread: Thread,
    message: Message
  ): Promise<AdminConversation> {
    const now = Date.now();
    const conversationName = conversationNameForThread(thread);
    const provider = providerFromThreadId(thread.id);
    const title = conversationTitle(thread);
    const preview = messagePreview(message);

    await this.subAgent(ConversationAgent, conversationName);
    this.sql`
      INSERT INTO chat_admin_conversations
        (thread_id, conversation_name, provider, title, last_message_preview,
         created_at, last_message_at)
      VALUES
        (${thread.id}, ${conversationName}, ${provider}, ${title}, ${preview},
         ${now}, ${now})
      ON CONFLICT(thread_id) DO UPDATE SET
        conversation_name = excluded.conversation_name,
        provider = excluded.provider,
        title = excluded.title,
        last_message_preview = excluded.last_message_preview,
        last_message_at = excluded.last_message_at
    `;

    return {
      threadId: thread.id,
      conversationName,
      provider,
      title,
      lastMessagePreview: preview || undefined,
      createdAt: now,
      lastMessageAt: now
    };
  }

  private async answerWithConversationAgent(
    thread: Thread,
    message: Message,
    fiber?: FiberContext
  ): Promise<void> {
    const callback = new TextStreamCallback({
      visibleSoftLimit: TELEGRAM_STREAM_SOFT_LIMIT
    });
    let agent: SubAgentStub<ConversationAgent> | undefined;
    let completedModelTurn = false;
    fiber?.stash(aiReplySnapshot("streaming", thread, message));
    const post = thread
      .post(callback.stream())
      .catch(async (error: unknown) => {
        if (isExpectedFinalEditNoop(error, callback)) {
          return;
        }

        const requestId = callback.requestId();
        if (agent && requestId) {
          await agent
            .cancelChat(requestId, toError(error).message)
            .catch(() => undefined);
        }
        callback.fail(error);
        throw error;
      });

    try {
      await thread.startTyping("Thinking...");
      agent = await this.getConversationAgent(thread);
      await agent.chat(toThinkUserMessage(message), callback);
      completedModelTurn = true;
      callback.close();
      await post;
      if (!callback.hasText()) {
        await thread.post(EMPTY_AI_RESPONSE);
      }
      for (const chunk of splitTelegramMessageText(callback.remainingText())) {
        await thread.post(chunk);
      }
      fiber?.stash(aiReplySnapshot("completed", thread, message));
    } catch (error) {
      callback.fail(error);
      await post.catch(() => undefined);
      const failureMode = aiReplyFailureMode(
        callback.hasText(),
        completedModelTurn,
        isExpectedFinalEditNoop(error, callback)
      );
      if (failureMode === null) {
        fiber?.stash(aiReplySnapshot("completed", thread, message));
        return;
      }

      if (failureMode === "apologize") {
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
    await this.recordConversation(thread, message);
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

  private shardThread(threadId: string): string {
    return threadId.split(":").slice(0, 2).join(":");
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

    if (
      request.method === "POST" &&
      url.pathname === "/setup/telegram-webhook"
    ) {
      return setupTelegramWebhook(request, env);
    }

    if (request.method === "POST" && url.pathname === WEBHOOK_PATH) {
      const agent = await getAgentByName(
        env.ChatIngressAgent,
        getIngressAgentName(request)
      );
      return agent.fetch(request);
    }

    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) {
      return agentResponse;
    }

    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Cloudflare.Env>;
