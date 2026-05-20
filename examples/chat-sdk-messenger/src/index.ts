import { createTelegramAdapter } from "@chat-adapter/telegram";
import { Agent, callable, getAgentByName, routeAgentRequest } from "agents";
import type {
  FiberContext,
  FiberRecoveryContext,
  FiberInspection,
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
const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_STREAM_SOFT_LIMIT = 3_400;
const TELEGRAM_FOLLOWUP_CHUNK_LIMIT = 3_500;
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

export type AdminConversation = {
  threadId: string;
  conversationName: string;
  provider: string;
  title: string;
  lastMessagePreview?: string;
  createdAt: number;
  lastMessageAt: number;
};

export type AdminReplyJob = {
  fiberId: string;
  status: FiberInspection["status"];
  threadId?: string;
  messageId?: string;
  createdAt: number;
  startedAt?: number;
  settledAt?: number;
  error?: string;
};

export type AdminSetupInfo = {
  webhookPath: string;
  agentName: string;
  telegramConfigured: boolean;
  telegramUserName: string;
};

export type TelegramWebhookSetupResult = {
  ok: boolean;
  webhookUrl: string;
  alreadyConfigured: boolean;
  description: string;
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
  hasStreamedText: boolean,
  completedModelTurn = false,
  expectedDeliveryCompletion = false
): "apologize" | "error" | null {
  if (expectedDeliveryCompletion) {
    return null;
  }

  if (completedModelTurn) {
    return "error";
  }

  return hasStreamedText ? "apologize" : "error";
}

export function isIgnorableDeliveryError(error: unknown): boolean {
  if (error === undefined || error === null) {
    return false;
  }

  const candidate = error as { code?: unknown; message?: unknown };
  const code = typeof candidate.code === "string" ? candidate.code : undefined;
  const message =
    typeof candidate.message === "string"
      ? candidate.message.toLowerCase()
      : String(error).toLowerCase();

  return (
    code === "VALIDATION_ERROR" && message.includes("message is not modified")
  );
}

export function isExpectedFinalEditNoop(
  error: unknown,
  callback: Pick<TextStreamCallback, "visibleLimitReached">
): boolean {
  return callback.visibleLimitReached() && isIgnorableDeliveryError(error);
}

export function splitTelegramMessageText(
  text: string,
  limit = TELEGRAM_FOLLOWUP_CHUNK_LIMIT
): string[] {
  if (!text.trim()) {
    return [];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n\n", limit);
    if (splitAt < Math.floor(limit * 0.5)) {
      splitAt = remaining.lastIndexOf("\n", limit);
    }
    if (splitAt < Math.floor(limit * 0.5)) {
      splitAt = remaining.lastIndexOf(" ", limit);
    }
    if (splitAt < Math.floor(limit * 0.5)) {
      splitAt = limit;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
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

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init?.headers
    }
  });
}

type TelegramApiResponse<T> =
  | {
      ok: true;
      result: T;
      description?: string;
    }
  | {
      ok: false;
      description?: string;
      error_code?: number;
    };

type TelegramWebhookInfo = {
  url?: string;
};

async function telegramApi<T>(
  token: string,
  method: string,
  body?: Record<string, unknown>
): Promise<TelegramApiResponse<T>> {
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body ?? {})
  });
  return (await response.json()) as TelegramApiResponse<T>;
}

async function setupTelegramWebhook(
  request: Request,
  env: Cloudflare.Env
): Promise<Response> {
  const requestUrl = new URL(request.url);
  const webhookUrl = `${requestUrl.origin}${WEBHOOK_PATH}`;
  if (requestUrl.protocol !== "https:") {
    return jsonResponse(
      {
        ok: false,
        webhookUrl,
        error:
          "Telegram webhooks require HTTPS. Open the Quick Tunnel or deployed Worker URL and click Set webhook here again."
      },
      { status: 400 }
    );
  }

  if (!env.TELEGRAM_BOT_TOKEN) {
    return jsonResponse(
      {
        ok: false,
        error: "TELEGRAM_BOT_TOKEN is not configured."
      },
      { status: 400 }
    );
  }

  if (!env.TELEGRAM_WEBHOOK_SECRET_TOKEN) {
    return jsonResponse(
      {
        ok: false,
        error: "TELEGRAM_WEBHOOK_SECRET_TOKEN is not configured."
      },
      { status: 400 }
    );
  }

  const current = await telegramApi<TelegramWebhookInfo>(
    env.TELEGRAM_BOT_TOKEN,
    "getWebhookInfo"
  );

  if (!current.ok) {
    return jsonResponse(
      {
        ok: false,
        webhookUrl,
        error: current.description ?? "Failed to inspect Telegram webhook."
      },
      { status: 502 }
    );
  }

  if (current.result.url === webhookUrl) {
    return jsonResponse({
      ok: true,
      webhookUrl,
      alreadyConfigured: true,
      description: "Telegram webhook already points at this origin."
    } satisfies TelegramWebhookSetupResult);
  }

  const next = await telegramApi<true>(env.TELEGRAM_BOT_TOKEN, "setWebhook", {
    url: webhookUrl,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET_TOKEN
  });

  if (!next.ok) {
    return jsonResponse(
      {
        ok: false,
        webhookUrl,
        error: next.description ?? "Failed to set Telegram webhook."
      },
      { status: 502 }
    );
  }

  return jsonResponse({
    ok: true,
    webhookUrl,
    alreadyConfigured: false,
    description: next.description ?? "Telegram webhook configured."
  } satisfies TelegramWebhookSetupResult);
}

export function getIngressAgentName(_request: Request): string {
  return DEFAULT_AGENT_NAME;
}

function providerFromThreadId(threadId: string): string {
  return threadId.split(":")[0] || "unknown";
}

function conversationTitle(thread: Thread): string {
  return `${providerFromThreadId(thread.id)}:${thread.id.split(":")[1] ?? thread.id}`;
}

function messagePreview(message: Message): string {
  return message.text.trim().slice(0, 160);
}

function metadataString(
  metadata: Record<string, unknown> | null | undefined,
  key: string
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function adminReplyJobFromFiber(fiber: FiberInspection): AdminReplyJob {
  return {
    fiberId: fiber.fiberId,
    status: fiber.status,
    threadId: metadataString(fiber.metadata, "threadId"),
    messageId: metadataString(fiber.metadata, "messageId"),
    createdAt: fiber.createdAt,
    startedAt: fiber.startedAt,
    settledAt: fiber.settledAt,
    error: fiber.error
  };
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
    const rows = this.sql<{
      thread_id: string;
      conversation_name: string;
      provider: string;
      title: string;
      last_message_preview: string | null;
      created_at: number;
      last_message_at: number;
    }>`
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

    return {
      threadId: row.thread_id,
      conversationName: row.conversation_name,
      provider: row.provider,
      title: row.title,
      lastMessagePreview: row.last_message_preview ?? undefined,
      createdAt: row.created_at,
      lastMessageAt: row.last_message_at
    };
  }

  private readConversations(): AdminConversation[] {
    const rows = this.sql<{
      thread_id: string;
      conversation_name: string;
      provider: string;
      title: string;
      last_message_preview: string | null;
      created_at: number;
      last_message_at: number;
    }>`
      SELECT thread_id, conversation_name, provider, title,
             last_message_preview, created_at, last_message_at
      FROM chat_admin_conversations
      ORDER BY last_message_at DESC
      LIMIT 100
    `;

    return rows.map((row) => ({
      threadId: row.thread_id,
      conversationName: row.conversation_name,
      provider: row.provider,
      title: row.title,
      lastMessagePreview: row.last_message_preview ?? undefined,
      createdAt: row.created_at,
      lastMessageAt: row.last_message_at
    }));
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
    const callback = new TextStreamCallback({
      visibleSoftLimit: TELEGRAM_STREAM_SOFT_LIMIT
    });
    let agent: SubAgentStub<ConversationAgent> | undefined;
    let completedModelTurn = false;
    let deliveryError: unknown;
    fiber?.stash(aiReplySnapshot("streaming", thread, message));
    const post = thread
      .post(callback.stream())
      .catch(async (error: unknown) => {
        deliveryError = error;
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
        isExpectedFinalEditNoop(deliveryError ?? error, callback)
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
