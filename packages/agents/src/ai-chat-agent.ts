import { Agent, type AgentContext, type Connection, type WSMessage } from "./";
import type {
  Message as ChatMessage,
  StreamTextOnFinishCallback,
  ToolSet,
} from "ai";
import { appendResponseMessages } from "ai";
import type { OutgoingMessage, IncomingMessage } from "./ai-types";
const decoder = new TextDecoder();

/**
 * Extension of Agent with built-in chat capabilities
 * @template Env Environment type containing bindings
 */
export class AIChatAgent<Env = unknown, State = unknown> extends Agent<
  Env,
  State
> {
  /** Array of chat messages for the current conversation */
  messages: ChatMessage[];
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    this.sql`create table if not exists cf_ai_chat_agent_messages (
      id text primary key,
      message text not null,
      created_at datetime default current_timestamp
    )`;
    this.messages = (
      this.sql`select * from cf_ai_chat_agent_messages` || []
    ).map((row) => {
      return JSON.parse(row.message as string);
    });
  }

  #broadcastChatMessage(message: OutgoingMessage, exclude?: string[]) {
    this.broadcast(JSON.stringify(message), exclude);
  }

  override async onMessage(connection: Connection, message: WSMessage) {
    if (typeof message === "string") {
      let data: IncomingMessage;
      try {
        data = JSON.parse(message) as IncomingMessage;
      } catch (error) {
        // silently ignore invalid messages for now
        // TODO: log errors with log levels
        return;
      }
      if (
        data.type === "cf_agent_use_chat_request" &&
        data.init.method === "POST"
      ) {
        const {
          method,
          keepalive,
          headers,
          body, // we're reading this
          redirect,
          integrity,
          credentials,
          mode,
          referrer,
          referrerPolicy,
          window,
          // dispatcher,
          // duplex
        } = data.init;
        const { messages } = JSON.parse(body as string);
        this.#broadcastChatMessage(
          {
            type: "cf_agent_chat_messages",
            messages,
          },
          [connection.id]
        );
        await this.#persistMessages(messages, [connection.id]);
        return this.#tryCatch(async () => {
          const response = await this.onChatMessage(async ({ response }) => {
            const finalMessages = appendResponseMessages({
              messages,
              responseMessages: response.messages,
            });

            await this.#persistMessages(finalMessages, [connection.id]);
          });
          if (response) {
            await this.#reply(data.id, response);
          }
        });
      }
      if (data.type === "cf_agent_chat_clear") {
        this.sql`delete from cf_ai_chat_agent_messages`;
        this.messages = [];
        this.#broadcastChatMessage(
          {
            type: "cf_agent_chat_clear",
          },
          [connection.id]
        );
      } else if (data.type === "cf_agent_chat_messages") {
        // replace the messages with the new ones
        await this.#persistMessages(data.messages, [connection.id]);
      }
    }
  }

  override async onRequest(request: Request): Promise<Response> {
    return this.#tryCatch(() => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/get-messages")) {
        const messages = (
          this.sql`select * from cf_ai_chat_agent_messages` || []
        ).map((row) => {
          return JSON.parse(row.message as string);
        });
        return Response.json(messages);
      }
      return super.onRequest(request);
    });
  }

  async #tryCatch<T>(fn: () => T | Promise<T>) {
    try {
      return await fn();
    } catch (e) {
      throw this.onError(e);
    }
  }

  /**
   * Handle incoming chat messages and generate a response
   * @param onFinish Callback to be called when the response is finished
   * @returns Response to send to the client or undefined
   */
  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>
  ): Promise<Response | undefined> {
    throw new Error(
      "recieved a chat message, override onChatMessage and return a Response to send to the client"
    );
  }

  /**
   * Save messages on the server side and trigger AI response
   * @param messages Chat messages to save
   */
  async saveMessages(messages: ChatMessage[]) {
    await this.#persistMessages(messages);
    const response = await this.onChatMessage(async ({ response }) => {
      const finalMessages = appendResponseMessages({
        messages,
        responseMessages: response.messages,
      });

      await this.#persistMessages(finalMessages, []);
    });
    if (response) {
      // we're just going to drain the body
      // @ts-ignore TODO: fix this type error
      for await (const chunk of response.body!) {
        decoder.decode(chunk);
      }
      response.body?.cancel();
    }
  }

  async #persistMessages(
    messages: ChatMessage[],
    excludeBroadcastIds: string[] = []
  ) {
    this.sql`delete from cf_ai_chat_agent_messages`;
    for (const message of messages) {
      this.sql`insert into cf_ai_chat_agent_messages (id, message) values (${
        message.id
      },${JSON.stringify(message)})`;
    }
    this.messages = messages;
    this.#broadcastChatMessage(
      {
        type: "cf_agent_chat_messages",
        messages: messages,
      },
      excludeBroadcastIds
    );
  }

  async #reply(id: string, response: Response) {
    // now take chunks out from dataStreamResponse and send them to the client
    return this.#tryCatch(async () => {
      // @ts-expect-error TODO: fix this type error
      for await (const chunk of response.body!) {
        const body = decoder.decode(chunk);

        this.#broadcastChatMessage({
          id,
          type: "cf_agent_use_chat_response",
          body,
          done: false,
        });
      }

      this.#broadcastChatMessage({
        id,
        type: "cf_agent_use_chat_response",
        body: "",
        done: true,
      });
    });
  }
}
