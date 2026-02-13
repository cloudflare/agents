/**
 * WebSocket-based ChatTransport for useAgentChat.
 *
 * Replaces the aiFetch + DefaultChatTransport indirection with a direct
 * WebSocket implementation that speaks the CF_AGENT protocol natively.
 *
 * Data flow (old): WS → aiFetch fake Response → DefaultChatTransport → useChat
 * Data flow (new): WS → WebSocketChatTransport → useChat
 */

import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { nanoid } from "nanoid";
import { MessageType, type OutgoingMessage } from "./types";

/**
 * Agent-like interface for sending/receiving WebSocket messages.
 * Matches the shape returned by useAgent from agents/react.
 */
export interface AgentConnection {
  send: (data: string) => void;
  addEventListener: (
    type: string,
    listener: (event: MessageEvent) => void,
    options?: { signal?: AbortSignal }
  ) => void;
  removeEventListener: (
    type: string,
    listener: (event: MessageEvent) => void
  ) => void;
}

export type WebSocketChatTransportOptions<
  ChatMessage extends UIMessage = UIMessage
> = {
  /** The agent connection from useAgent */
  agent: AgentConnection;
  /**
   * Callback to prepare the request body before sending.
   * Can add custom headers, body fields, or credentials.
   */
  prepareBody?: (options: {
    messages: ChatMessage[];
    trigger: "submit-message" | "regenerate-message";
    messageId?: string;
  }) => Promise<Record<string, unknown>> | Record<string, unknown>;
  /**
   * Optional set to track active request IDs.
   * IDs are added when a request starts and removed when it completes.
   * Used by the onAgentMessage handler to skip messages already handled by the transport.
   */
  activeRequestIds?: Set<string>;
};

/**
 * ChatTransport that sends messages over WebSocket and returns a
 * ReadableStream<UIMessageChunk> that the AI SDK's useChat consumes directly.
 * No fake fetch, no Response reconstruction, no double SSE parsing.
 */
export class WebSocketChatTransport<
  ChatMessage extends UIMessage = UIMessage
> implements ChatTransport<ChatMessage> {
  private agent: AgentConnection;
  private prepareBody?: WebSocketChatTransportOptions<ChatMessage>["prepareBody"];
  private activeRequestIds?: Set<string>;

  constructor(options: WebSocketChatTransportOptions<ChatMessage>) {
    this.agent = options.agent;
    this.prepareBody = options.prepareBody;
    this.activeRequestIds = options.activeRequestIds;
  }

  async sendMessages(options: {
    chatId: string;
    messages: ChatMessage[];
    abortSignal: AbortSignal | undefined;
    trigger: "submit-message" | "regenerate-message";
    messageId?: string;
    body?: object;
    headers?: Record<string, string> | Headers;
    metadata?: unknown;
  }): Promise<ReadableStream<UIMessageChunk>> {
    const requestId = nanoid(8);
    const abortController = new AbortController();
    let completed = false;

    // Build the request body
    let extraBody: Record<string, unknown> = {};
    if (this.prepareBody) {
      extraBody = await this.prepareBody({
        messages: options.messages,
        trigger: options.trigger,
        messageId: options.messageId
      });
    }
    if (options.body) {
      extraBody = {
        ...extraBody,
        ...(options.body as Record<string, unknown>)
      };
    }

    const bodyPayload = JSON.stringify({
      messages: options.messages,
      ...extraBody
    });

    // Track this request so the onAgentMessage handler skips it
    this.activeRequestIds?.add(requestId);

    // Handle abort from the caller (only if the stream has not already completed)
    options.abortSignal?.addEventListener("abort", () => {
      if (completed) return;
      this.agent.send(
        JSON.stringify({
          id: requestId,
          type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL
        })
      );
      this.activeRequestIds?.delete(requestId);
      abortController.abort();
    });

    // Create a ReadableStream<UIMessageChunk> that emits parsed chunks
    // as they arrive over the WebSocket
    const agent = this.agent;
    const activeIds = this.activeRequestIds;
    const stream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        const onMessage = (event: MessageEvent) => {
          try {
            const data = JSON.parse(
              event.data as string
            ) as OutgoingMessage<ChatMessage>;

            if (data.type !== MessageType.CF_AGENT_USE_CHAT_RESPONSE) return;
            if (data.id !== requestId) return;

            if (data.error) {
              completed = true;
              controller.error(new Error(data.body));
              activeIds?.delete(requestId);
              abortController.abort();
              return;
            }

            // Parse the body as UIMessageChunk and enqueue
            if (data.body?.trim()) {
              try {
                const chunk = JSON.parse(data.body) as UIMessageChunk;
                controller.enqueue(chunk);
              } catch {
                // Skip malformed chunk bodies
              }
            }

            if (data.done) {
              completed = true;
              try {
                controller.close();
              } catch {
                // Stream may already be closed
              }
              activeIds?.delete(requestId);
              abortController.abort();
            }
          } catch {
            // Ignore non-JSON messages
          }
        };

        agent.addEventListener("message", onMessage, {
          signal: abortController.signal
        });
      },
      cancel() {
        abortController.abort();
      }
    });

    // Send the request over WebSocket
    agent.send(
      JSON.stringify({
        id: requestId,
        init: {
          method: "POST",
          body: bodyPayload
        },
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST
      })
    );

    return stream;
  }

  async reconnectToStream(_options: {
    chatId: string;
  }): Promise<ReadableStream<UIMessageChunk> | null> {
    // Stream resumption is handled by the onAgentMessage handler
    // in useAgentChat (CF_AGENT_STREAM_RESUME_REQUEST flow).
    // The transport returns null to let the hook handle it.
    return null;
  }
}
