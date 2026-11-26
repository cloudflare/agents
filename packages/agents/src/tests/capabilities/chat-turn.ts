import { DurableObject } from "cloudflare:workers";
import type { UIMessageChunk } from "ai";
import { Lifecycle } from "../../lifecycle";
import { Sessions } from "../../sessions/sessions";
import { Streams } from "../../streams/streams";
import { Tasks } from "../../tasks/tasks";
import {
  chatTurnDefinition,
  type ChatHost,
  type ChatModelCall,
  type ChatTurnResult
} from "../../chat/chat-host";

/**
 * A minimal host of the chat-turn definition: Tasks, Streams and Sessions on
 * a Durable Object, and a `respond` that streams a fixed reply.
 */
export class ChatTurnHostObject extends DurableObject<Cloudflare.Env> {
  readonly calls: ChatModelCall[] = [];
  readonly results: ChatTurnResult[] = [];
  /** What `respond` streams; `null` answers nothing. */
  reply: UIMessageChunk[] | null = [
    { type: "start", messageId: "reply-1" },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "Hello" },
    { type: "text-end", id: "t1" },
    { type: "finish" }
  ];

  readonly streams = new Streams();
  readonly sessions = new Sessions();
  readonly host: ChatHost = {
    respond: async (call) => {
      this.calls.push(call);
      const reply = this.reply;
      if (!reply) return undefined;
      return new ReadableStream<UIMessageChunk>({
        start(controller) {
          for (const chunk of reply) controller.enqueue(chunk);
          controller.close();
        }
      });
    },
    hooks: {
      onResponse: (result) => {
        this.results.push(result);
        for (const waiter of this.#waiters.splice(0)) waiter(result);
      }
    }
  };
  #waiters: Array<(result: ChatTurnResult) => void> = [];
  /** The result of turn `requestId`, now or when it is reported. */
  async resultFor(requestId: string): Promise<ChatTurnResult> {
    for (;;) {
      const found = this.results.find((r) => r.requestId === requestId);
      if (found) return found;
      await this.nextResult();
    }
  }
  /** The next turn result reported to `onResponse`. */
  nextResult(): Promise<ChatTurnResult> {
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
  readonly lane = { definition: "__cf_chat_turn", lane: "chat:s1" };
  readonly tasks: Tasks = new Tasks();
  get deps() {
    return {
      tasks: this.tasks,
      streams: this.streams,
      sessions: this.sessions,
      session: "s1"
    };
  }
  readonly lifecycle = Lifecycle.install(this)
    .use(this.streams)
    .use(this.sessions)
    .use(this.tasks);

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.tasks.register(
      "__cf_chat_turn",
      chatTurnDefinition(this.deps, this.host, { name: "__cf_chat_turn" })
    );
  }
}
