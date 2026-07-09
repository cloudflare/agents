import {
  MessageType,
  type IncomingMessage,
  type OutgoingMessage
} from "agents/chat";
import type { UIMessageChunk } from "ai";
import type { Primitive } from "../primitives";
import type {
  ChannelIn,
  ChannelOut,
  InboundMessage,
  MessageHandler,
  OutStream
} from "./types";
import { errorText } from "./utils";

export type WebSocketChatRequestFrame = Extract<
  IncomingMessage,
  { type: MessageType.CF_AGENT_USE_CHAT_REQUEST }
>;

export type WebSocketChatResponseFrame = Extract<
  OutgoingMessage,
  { type: MessageType.CF_AGENT_USE_CHAT_RESPONSE }
>;

/** Raw WebSocket request frame plus the hibernation connection id tag. */
export interface WebSocketRaw {
  frame: WebSocketChatRequestFrame;
  connectionId: string;
}

/** Serializable target used to re-resolve a hibernated WebSocket connection. */
export interface WebSocketTarget {
  connectionId: string;
  requestId: string;
}

/** WebSocket channel for the Agent chat protocol compatibility slice. */
export class WebSocketChannel
  implements
    Primitive,
    ChannelIn<WebSocketRaw, WebSocketTarget>,
    ChannelOut<WebSocketTarget>
{
  readonly channelId: string;
  #handler?: MessageHandler<WebSocketRaw, WebSocketTarget>;
  private path: string;

  constructor(
    private ctx: DurableObjectState,
    options: { channelId?: string; path?: string } = {}
  ) {
    this.channelId = options.channelId ?? "websocket";
    this.path = options.path ?? "/ws";
  }

  onMessage(
    handler: MessageHandler<WebSocketRaw, WebSocketTarget>
  ): () => void {
    this.#handler = handler;
    return () => {
      if (this.#handler === handler) this.#handler = undefined;
    };
  }

  fetch(request: Request): Response | undefined {
    if (new URL(request.url).pathname !== this.path) return undefined;
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return undefined;
    }

    const connectionId = crypto.randomUUID();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [this.channelId, connectionId]);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    const connectionId = this.connectionId(ws);
    if (!connectionId || typeof message !== "string") return;

    const frame = parseChatRequestFrame(message);
    if (!frame) return;

    await this.emit({
      channelId: this.channelId,
      from: connectionId,
      body: requestBodyText(frame.init?.body),
      replyTo: { connectionId, requestId: frame.id },
      raw: { frame, connectionId }
    });
  }

  webSocketClose(_ws: WebSocket): void {}

  webSocketError(_ws: WebSocket): void {}

  openStream(target: WebSocketTarget): OutStream {
    const send = (frame: WebSocketChatResponseFrame) => {
      const ws = this.ctx.getWebSockets(target.connectionId)[0];
      if (!ws) return;
      ws.send(JSON.stringify(frame));
    };

    return {
      write(chunk) {
        send(responseFrame(target.requestId, JSON.stringify(chunk), false));
      },
      complete() {
        send(responseFrame(target.requestId, "", true));
      },
      interrupt() {
        send(
          responseFrame(
            target.requestId,
            JSON.stringify({ type: "abort" } satisfies UIMessageChunk),
            false
          )
        );
        send(responseFrame(target.requestId, "", true));
      },
      error(err) {
        send(responseFrame(target.requestId, errorText(err), true, true));
      }
    };
  }

  private connectionId(ws: WebSocket): string | undefined {
    const tags = this.ctx.getTags(ws);
    if (!tags.includes(this.channelId)) return undefined;
    return tags.find((tag) => tag !== this.channelId);
  }

  private async emit(
    msg: InboundMessage<WebSocketRaw, WebSocketTarget>
  ): Promise<void> {
    await this.#handler?.(msg);
  }
}

function responseFrame(
  id: string,
  body: string,
  done: boolean,
  error?: boolean
): WebSocketChatResponseFrame {
  return {
    type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
    id,
    body,
    done,
    error
  };
}

function parseChatRequestFrame(
  message: string
): WebSocketChatRequestFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  if (parsed.type !== MessageType.CF_AGENT_USE_CHAT_REQUEST) return null;
  if (typeof parsed.id !== "string") return null;
  return {
    type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
    id: parsed.id,
    init: isRecord(parsed.init) ? { body: parsed.init.body } : undefined
  } as WebSocketChatRequestFrame;
}

function requestBodyText(body: unknown): string {
  if (typeof body === "string") return body;
  if (body === undefined || body === null) return "";
  return JSON.stringify(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
