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

  private sendChatMessage(connection: Connection, message: OutgoingMessage) {
    try {
      connection.send(JSON.stringify(message));
    } catch (e) {
      // silently ignore
    }
  }

  private broadcastChatMessage(message: OutgoingMessage, exclude?: string[]) {
    try {
      this.broadcast(JSON.stringify(message), exclude);
    } catch (e) {
      // silently ignore
    }
  }

  override async onMessage(connection: Connection, message: WSMessage) {
    if (typeof message === "string") {
      const data = JSON.parse(message) as IncomingMessage;
      if (data.type === "cf_agent_chat_init") {
        connection.setState({
          ...connection.state,
          isChatConnection: true,
        });
      } else if (
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
        this.broadcastChatMessage(
          {
            type: "cf_agent_chat_messages",
            messages,
          },
          [connection.id]
        );
        await this.persistMessages(messages, [connection.id]);
        const response = await this.onChatMessage(async ({ response }) => {
          const finalMessages = appendResponseMessages({
            messages,
            responseMessages: response.messages,
          });

          await this.persistMessages(finalMessages, [connection.id]);
        });
        if (response) {
          await this.reply(data.id, response);
        }
      } else if (data.type === "cf_agent_chat_clear") {
        this.sql`delete from cf_ai_chat_agent_messages`;
        this.messages = [];
        this.broadcastChatMessage(
          {
            type: "cf_agent_chat_clear",
          },
          [connection.id]
        );
      } else if (data.type === "cf_agent_chat_messages") {
        // replace the messages with the new ones
        await this.persistMessages(data.messages, [connection.id]);
      }
    }
  }

  override async onRequest(request: Request): Promise<Response> {
    if (request.url.endsWith("/get-messages")) {
      const messages = (
        this.sql`select * from cf_ai_chat_agent_messages` || []
      ).map((row) => {
        return JSON.parse(row.message as string);
      });
      return new Response(JSON.stringify(messages));
    }
    return super.onRequest(request);
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
    await this.persistMessages(messages);
    const response = await this.onChatMessage(async ({ response }) => {
      const finalMessages = appendResponseMessages({
        messages,
        responseMessages: response.messages,
      });

      await this.persistMessages(finalMessages, []);
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

  private async persistMessages(
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
    this.broadcastChatMessage(
      {
        type: "cf_agent_chat_messages",
        messages: messages,
      },
      excludeBroadcastIds
    );
  }

  private async reply(id: string, response: Response) {
    const chatConnections = [...this.getConnections()].filter(
      (conn: Connection<{ isChatConnection?: boolean }>) =>
        conn.state?.isChatConnection
    );
    // now take chunks out from dataStreamResponse and send them to the client

    // @ts-ignore TODO: fix this type error
    for await (const chunk of response.body!) {
      const body = decoder.decode(chunk);

      for (const conn of chatConnections) {
        this.sendChatMessage(conn, {
          id,
          type: "cf_agent_use_chat_response",
          body,
          done: false,
        });
      }
    }

    for (const conn of chatConnections) {
      this.sendChatMessage(conn, {
        id,
        type: "cf_agent_use_chat_response",
        body: "",
        done: true,
      });
    }
  }
}
