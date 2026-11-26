import { DurableObject } from "cloudflare:workers";
import type { UIMessageChunk } from "ai";
import { Lifecycle } from "../../lifecycle";
import { Sessions } from "../../sessions/sessions";
import { Streams } from "../../streams/streams";
import { Tasks } from "../../tasks/tasks";
import type { TaskStep } from "../../tasks/types";
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
    { type: "start", messageId: "a1" },
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
    hooks: { onResponse: (result) => void this.results.push(result) }
  };
  readonly tasks: Tasks = new Tasks({
    definitions: {
      turn: (input: unknown, step: TaskStep) =>
        chatTurnDefinition(
          {
            tasks: this.tasks,
            streams: this.streams,
            sessions: this.sessions,
            session: "s1"
          },
          this.host,
          { name: "turn" }
        )(input, step)
    }
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.streams)
    .use(this.sessions)
    .use(this.tasks);
}
