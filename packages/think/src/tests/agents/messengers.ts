import type { LanguageModel } from "ai";
import type { Adapter, ChatInstance } from "chat";
import { Message, parseMarkdown } from "chat";
import { Think } from "../../think";
import { chatSdkMessenger, type ThinkMessengers } from "../../messengers";

const fakeAdapter = {
  channelIdFromThreadId(threadId: string) {
    return threadId;
  },
  decodeThreadId(threadId: string) {
    return threadId;
  },
  deleteMessage() {
    return Promise.resolve();
  },
  editMessage() {
    return Promise.resolve({ id: "edited", raw: {}, threadId: "fake" });
  },
  encodeThreadId(threadId: string) {
    return threadId;
  },
  fetchMessages() {
    return Promise.resolve({ messages: [] });
  },
  fetchThread(threadId: string) {
    return Promise.resolve({
      channelId: threadId,
      id: threadId,
      isDM: false,
      metadata: {}
    });
  },
  handleWebhook() {
    return Promise.resolve(new Response("messenger"));
  },
  initialize() {
    return Promise.resolve();
  },
  postMessage() {
    return Promise.resolve({ id: "posted", raw: {}, threadId: "fake" });
  },
  removeReaction() {
    return Promise.resolve();
  },
  addReaction() {
    return Promise.resolve();
  },
  userName: "fake_bot"
} as unknown as Adapter;

/** Webhook body for {@link ThinkMessengerDeliveryTestAgent}. */
export interface FakeMessengerWebhook {
  author?: { fullName: string; userId: string };
  id: string;
  isMention?: boolean;
  text: string;
  threadId: string;
}

function lastUserText(prompt: unknown): string {
  const messages = Array.isArray(prompt) ? [...prompt].reverse() : [];
  const user = messages.find(
    (message: { role?: string }) => message.role === "user"
  ) as { content?: Array<{ type: string; text?: string }> } | undefined;
  return (user?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

/**
 * Drives real messenger replies end to end: each webhook is handed to the
 * runtime's own `Chat` (concurrency strategy, handlers, delivery), the model
 * reply streams back through the adapter's post/edit fallback, and both what
 * the model was asked and what the adapter sent are recorded in agent SQL.
 * Thread ids starting with `fake:dm` are direct messages.
 */
export class ThinkMessengerDeliveryTestAgent extends Think {
  private _chat: ChatInstance | undefined;

  override getModel(): LanguageModel {
    const record = (text: string) => this._record("prompt", text);
    return {
      specificationVersion: "v3",
      provider: "test",
      modelId: "messenger-delivery-mock",
      supportedUrls: {},
      doGenerate() {
        throw new Error("doGenerate not implemented in mock");
      },
      doStream(options: { prompt: unknown }) {
        record(lastUserText(options.prompt));
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t" });
            for (const delta of ["Got ", "it"]) {
              controller.enqueue({ type: "text-delta", id: "t", delta });
            }
            controller.enqueue({ type: "text-end", id: "t" });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: 0,
                  cacheWrite: 0
                },
                outputTokens: { total: 1, text: 1, reasoning: 0 }
              }
            });
            controller.close();
          }
        });
        return Promise.resolve({ stream });
      }
    } as LanguageModel;
  }

  override getMessengers(): ThinkMessengers {
    return {
      fake: chatSdkMessenger({
        adapter: this._recordingAdapter(),
        conversation: "self",
        provider: "fake",
        userName: "fake_bot",
        verifyWebhook: false
      })
    };
  }

  async getRecorded(kind: "prompt" | "post" | "edit"): Promise<string[]> {
    this._ensureTable();
    return this.sql<{ content: string }>`
      SELECT content FROM messenger_delivery_log
      WHERE kind = ${kind} ORDER BY seq ASC
    `.map((row) => row.content);
  }

  async getAdapterCalls(): Promise<Array<{ kind: string; content: string }>> {
    this._ensureTable();
    return this.sql<{ kind: string; content: string }>`
      SELECT kind, content FROM messenger_delivery_log
      WHERE kind != 'prompt' ORDER BY seq ASC
    `;
  }

  private _ensureTable(): void {
    this.sql`CREATE TABLE IF NOT EXISTS messenger_delivery_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, content TEXT
    )`;
  }

  private _record(kind: string, content: string): void {
    this._ensureTable();
    this.sql`
      INSERT INTO messenger_delivery_log (kind, content)
      VALUES (${kind}, ${content})
    `;
  }

  private _recordingAdapter(): Adapter {
    const text = (message: unknown) =>
      typeof message === "string"
        ? message
        : String((message as { markdown?: string }).markdown);
    const adapter = {
      ...fakeAdapter,
      name: "fake",
      editMessage: (threadId: string, _id: string, message: unknown) => {
        this._record("edit", text(message));
        return Promise.resolve({ id: "reply", raw: {}, threadId });
      },
      handleWebhook: async (request: Request) => {
        const body = (await request.json()) as FakeMessengerWebhook;
        const author = body.author ?? { fullName: "Ada", userId: "user-ada" };
        await this._chat?.processMessage(
          adapter,
          body.threadId,
          new Message({
            attachments: [],
            author: {
              fullName: author.fullName,
              isBot: false,
              isMe: false,
              userId: author.userId,
              userName: author.fullName.toLowerCase()
            },
            formatted: parseMarkdown(body.text),
            id: body.id,
            isMention: body.isMention,
            metadata: { dateSent: new Date(), edited: false },
            raw: {},
            text: body.text,
            threadId: body.threadId
          })
        );
        return new Response("ok");
      },
      initialize: (chat: ChatInstance) => {
        this._chat = chat;
        return Promise.resolve();
      },
      isDM: (threadId: string) => threadId.startsWith("fake:dm"),
      postMessage: (threadId: string, message: unknown) => {
        this._record("post", text(message));
        return Promise.resolve({ id: "reply", raw: {}, threadId });
      },
      startTyping: () => Promise.resolve()
    } as unknown as Adapter;
    return adapter;
  }
}

export class ThinkMessengerRouteTestAgent extends Think {
  override getMessengers(): ThinkMessengers {
    return {
      fake: chatSdkMessenger({
        adapter: fakeAdapter,
        provider: "fake",
        userName: "fake_bot",
        verifyWebhook: false
      })
    };
  }

  override onRequest(_request: Request): Response | Promise<Response> {
    return new Response("fallback");
  }
}
