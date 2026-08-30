import type { UIMessageChunk } from "ai";
import type { Connection } from "agents";
import {
  CHAT_MESSAGE_TYPES,
  STREAM_RESUME_NONE_REASONS,
  parseProtocolMessage
} from "agents/chat";
import { WebSockets, type WebSocketsOptions } from "agents/websockets";
import type {
  Channel,
  ChannelChunk,
  ChannelMessage,
  ChannelRoute,
  ChannelStreamOptions,
  DeliveryResult
} from "../channel";
import type { ChannelIngressEnvelope } from "../ingress";
import {
  bindChannelIngress,
  defaultText,
  type BindableChannelIngress
} from "../internal";
import { consumeChunks } from "../stream";
import {
  isChannelMessageSurface,
  type ChannelMessageSurface
} from "../surface";
import {
  normalizeWebChatRequest,
  WebChatChunkEncoder,
  type WebChatRequestBody
} from "./web-protocol";

export type WebChatSurface = ChannelMessageSurface<
  string,
  { connectionId: string; requestId: string }
>;

/** Exact browser request retained for application routing. */
export type WebChatIngressPayload = {
  requestId: string;
  init: { method?: string; body?: string; [key: string]: unknown };
  body: WebChatRequestBody;
};

export type WebChannelOptions = {
  /** Select an application route from the browser turn and Host context. */
  route?: ChannelRoute<WebChatIngressPayload>;
  /** Additional configuration for the owned WebSockets capability. */
  webSockets?: Omit<WebSocketsOptions, "handlers">;
};

/**
 * A browser chat Channel paired with the WebSockets capability it uses.
 * Install `webSockets` into the Durable Object's Lifecycle.
 */
export interface WebChannel extends Channel<WebChatIngressPayload> {
  readonly webSockets: WebSockets;
}

type WebChatAddress = WebChatSurface["address"];

function addressOf(surface: ChannelMessageSurface): WebChatAddress | null {
  if (
    !isChannelMessageSurface(surface) ||
    surface.version !== 1 ||
    surface.address === null ||
    typeof surface.address !== "object" ||
    Array.isArray(surface.address)
  ) {
    return null;
  }
  const address = surface.address as Record<string, unknown>;
  return typeof address.connectionId === "string" &&
    typeof address.requestId === "string"
    ? {
        connectionId: address.connectionId,
        requestId: address.requestId
      }
    : null;
}

function streamFailure(
  sent: boolean,
  code: string,
  message: string
): DeliveryResult {
  return sent
    ? { status: "uncertain", error: { code, message } }
    : { status: "failed", retryable: true, error: { code, message } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The stream ended early";
}

function responseFrame(
  requestId: string,
  body: UIMessageChunk | string,
  options: { done: boolean; error?: boolean }
): string {
  return JSON.stringify({
    body: typeof body === "string" ? body : JSON.stringify(body),
    done: options.done,
    id: requestId,
    type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
    ...(options.error === true && { error: true })
  });
}

class ConfiguredWebChannel
  implements WebChannel, BindableChannelIngress<WebChatIngressPayload>
{
  readonly route: ChannelRoute<WebChatIngressPayload> | undefined;
  readonly webSockets: WebSockets;
  readonly #active = new Map<string, AbortController>();
  #dispatch:
    | ((
        envelope: ChannelIngressEnvelope<WebChatIngressPayload>
      ) => Promise<void>)
    | undefined;

  constructor(options: WebChannelOptions) {
    this.route = options.route;
    this.webSockets = new WebSockets({
      ...options.webSockets,
      handlers: {
        onMessage: (connection, message) =>
          this.#onMessage(connection, message),
        onClose: (connection) => this.#cancelConnection(connection.id),
        onError: (connection) => this.#cancelConnection(connection.id)
      }
    });
  }

  [bindChannelIngress](
    dispatch: (
      envelope: ChannelIngressEnvelope<WebChatIngressPayload>
    ) => Promise<void>
  ): void {
    if (this.#dispatch) {
      throw new Error(
        "A web Channel can only be configured in one ChannelHost"
      );
    }
    this.#dispatch = dispatch;
  }

  isAvailable(surface: ChannelMessageSurface): boolean {
    const address = addressOf(surface);
    return Boolean(
      address && this.webSockets.getConnection(address.connectionId)
    );
  }

  deliver(
    surface: ChannelMessageSurface,
    message: ChannelMessage
  ): Promise<DeliveryResult> {
    const text = defaultText(message);
    return this.stream(
      surface,
      new ReadableStream<ChannelChunk>({
        start(controller) {
          controller.enqueue({ type: "text", text });
          controller.close();
        }
      }),
      {}
    );
  }

  async stream(
    surface: ChannelMessageSurface,
    chunks: ReadableStream<ChannelChunk>,
    _options: ChannelStreamOptions
  ): Promise<DeliveryResult> {
    const address = addressOf(surface);
    if (!address) {
      await chunks.cancel().catch(() => {});
      return {
        status: "failed",
        retryable: false,
        error: {
          code: "WEB_CHAT_SURFACE_INVALID",
          message: `Web chat cannot parse the address for Channel "${surface.channelKey}"`
        }
      };
    }

    const connection = this.webSockets.getConnection(address.connectionId);
    if (!connection) {
      await chunks.cancel().catch(() => {});
      return {
        status: "failed",
        retryable: true,
        error: {
          code: "WEB_CHAT_CONNECTION_UNAVAILABLE",
          message: "The browser connection is no longer available"
        }
      };
    }

    const key = this.#requestKey(address.connectionId, address.requestId);
    this.#active.get(key)?.abort();
    const abort = new AbortController();
    this.#active.set(key, abort);
    const encoder = new WebChatChunkEncoder(address.requestId);
    let sent = false;

    try {
      return await consumeChunks(
        chunks,
        {
          onChunk: (chunk) => {
            for (const output of encoder.push(chunk)) {
              connection.send(
                responseFrame(address.requestId, output, { done: false })
              );
              sent = true;
            }
          },
          onFinish: (outcome) => {
            try {
              for (const output of encoder.finishPart()) {
                connection.send(
                  responseFrame(address.requestId, output, { done: false })
                );
                sent = true;
              }
              if (outcome.interrupted) {
                const message = errorMessage(outcome.error);
                connection.send(
                  responseFrame(address.requestId, message, {
                    done: true,
                    error: true
                  })
                );
                return streamFailure(
                  sent,
                  "WEB_CHAT_STREAM_INTERRUPTED",
                  message
                );
              }
              connection.send(
                responseFrame(address.requestId, "", { done: true })
              );
              return { status: "delivered" };
            } catch (error) {
              return streamFailure(
                sent,
                "WEB_CHAT_DELIVERY_FAILED",
                errorMessage(error)
              );
            }
          }
        },
        { signal: abort.signal }
      );
    } finally {
      if (this.#active.get(key) === abort) this.#active.delete(key);
    }
  }

  async #onMessage(
    connection: Connection,
    message: string | ArrayBuffer | ArrayBufferView
  ): Promise<void> {
    if (typeof message !== "string") return;
    const event = parseProtocolMessage(message);
    if (!event) return;

    switch (event.type) {
      case "chat-request":
        await this.#onChatRequest(connection, event.id, event.init);
        return;
      case "cancel":
        this.#active
          .get(this.#requestKey(connection.id, event.id))
          ?.abort(
            new DOMException("The browser cancelled the request", "AbortError")
          );
        return;
      case "clear":
        this.#cancelConnection(connection.id);
        connection.send(
          JSON.stringify({ type: CHAT_MESSAGE_TYPES.CHAT_CLEAR })
        );
        return;
      case "stream-resume-request":
        connection.send(
          JSON.stringify({
            type: CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE,
            reason: STREAM_RESUME_NONE_REASONS.IDLE,
            ...(event.probeId !== undefined && { probeId: event.probeId })
          })
        );
        return;
      case "stream-resume-ack":
      case "tool-result":
      case "tool-approval":
      case "messages":
        return;
    }
  }

  async #onChatRequest(
    connection: Connection,
    requestId: string,
    init: { method?: string; body?: string; [key: string]: unknown }
  ): Promise<void> {
    try {
      if (
        typeof requestId !== "string" ||
        !requestId ||
        (init.method ?? "POST").toUpperCase() !== "POST"
      ) {
        throw new Error("Web chat requires a POST request with an id");
      }
      const normalized = normalizeWebChatRequest(JSON.parse(init.body ?? ""));
      if (!normalized) {
        throw new Error("Web chat requires a body with a user message");
      }
      if (!this.#dispatch) {
        throw new Error("The web Channel is not configured in a ChannelHost");
      }

      const raw = {
        requestId,
        init,
        body: normalized.body
      } satisfies WebChatIngressPayload;
      await this.#dispatch({
        raw,
        event: {
          type: "message",
          eventId: `web:${connection.id}:request:${requestId}`,
          thread: { id: connection.id, isDirectMessage: true },
          replySurface: {
            version: 1,
            address: { connectionId: connection.id, requestId },
            label: "Web chat"
          },
          actor: { id: connection.id },
          message: normalized.message
        }
      });
    } catch (error) {
      connection.send(
        responseFrame(requestId, errorMessage(error), {
          done: true,
          error: true
        })
      );
    }
  }

  #cancelConnection(connectionId: string): void {
    const prefix = `${connectionId}\u0000`;
    for (const [key, controller] of this.#active) {
      if (key.startsWith(prefix)) controller.abort();
    }
  }

  #requestKey(connectionId: string, requestId: string): string {
    return `${connectionId}\u0000${requestId}`;
  }
}

/**
 * Create a Channel that speaks the AIChatAgent browser protocol over an owned
 * WebSockets capability. The Host still owns all application message handling.
 */
export function web(options: WebChannelOptions = {}): WebChannel {
  return new ConfiguredWebChannel(options);
}
