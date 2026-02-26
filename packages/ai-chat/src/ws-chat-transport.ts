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
  agent: AgentConnection;
  private prepareBody?: WebSocketChatTransportOptions<ChatMessage>["prepareBody"];
  private activeRequestIds?: Set<string>;

  // Pending resume resolver — set by reconnectToStream, called by
  // handleStreamResuming when onAgentMessage sees CF_AGENT_STREAM_RESUMING.
  private _resumeResolver: ((data: { id: string }) => void) | null = null;

  constructor(options: WebSocketChatTransportOptions<ChatMessage>) {
    this.agent = options.agent;
    this.prepareBody = options.prepareBody;
    this.activeRequestIds = options.activeRequestIds;
  }

  /**
   * Called by onAgentMessage when it receives CF_AGENT_STREAM_RESUMING.
   * If reconnectToStream is waiting, this handles the resume handshake
   * (ACK + stream creation) and returns true. Otherwise returns false
   * so the caller can use its own fallback path.
   */
  handleStreamResuming(data: { id: string }): boolean {
    if (!this._resumeResolver) return false;
    this._resumeResolver(data);
    return true;
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
      trigger: options.trigger,
      ...extraBody
    });

    // Track this request so the onAgentMessage handler skips it
    this.activeRequestIds?.add(requestId);

    // Create a ReadableStream<UIMessageChunk> that emits parsed chunks
    // as they arrive over the WebSocket
    const agent = this.agent;
    const activeIds = this.activeRequestIds;

    // Single cleanup helper — every terminal path (done, error, abort)
    // goes through here exactly once.
    const finish = (action: () => void) => {
      if (completed) return;
      completed = true;
      try {
        action();
      } catch {
        // Stream may already be closed
      }
      activeIds?.delete(requestId);
      abortController.abort();
    };

    const abortError = new Error("Aborted");
    abortError.name = "AbortError";

    // Abort handler: send cancel to server, then terminate the stream.
    // Used by both the caller's abortSignal and stream.cancel().
    const onAbort = () => {
      if (completed) return;
      try {
        agent.send(
          JSON.stringify({
            id: requestId,
            type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL
          })
        );
      } catch {
        // Ignore failures (e.g. agent already disconnected)
      }
      finish(() => streamController.error(abortError));
    };

    // streamController is assigned synchronously by start(), so it is
    // always available by the time onAbort or onMessage can fire.
    let streamController!: ReadableStreamDefaultController<UIMessageChunk>;

    const stream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        streamController = controller;

        const onMessage = (event: MessageEvent) => {
          try {
            const data = JSON.parse(
              event.data as string
            ) as OutgoingMessage<ChatMessage>;

            if (data.type !== MessageType.CF_AGENT_USE_CHAT_RESPONSE) return;
            if (data.id !== requestId) return;

            if (data.error) {
              finish(() =>
                controller.error(new Error(data.body || "Stream error"))
              );
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
              finish(() => controller.close());
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
        onAbort();
      }
    });

    // Handle abort from the caller
    if (options.abortSignal) {
      options.abortSignal.addEventListener("abort", onAbort, { once: true });
      if (options.abortSignal.aborted) onAbort();
    }

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
    // Detect whether the server has an active stream for this chat.
    // Instead of registering our own addEventListener listener (which
    // races with onAgentMessage), we set _resumeResolver so that
    // onAgentMessage can call handleStreamResuming() synchronously
    // when it sees CF_AGENT_STREAM_RESUMING — eliminating the race.
    const activeIds = this.activeRequestIds;

    return new Promise<ReadableStream<UIMessageChunk> | null>((resolve) => {
      let resolved = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const done = (value: ReadableStream<UIMessageChunk> | null) => {
        if (resolved) return;
        resolved = true;
        this._resumeResolver = null;
        if (timeout) clearTimeout(timeout);
        resolve(value);
      };

      // Set the resolver that handleStreamResuming() will call.
      // When onAgentMessage sees CF_AGENT_STREAM_RESUMING, it calls
      // handleStreamResuming() which invokes this callback.
      this._resumeResolver = (data: { id: string }) => {
        const requestId = data.id;

        // Track this request so onAgentMessage skips subsequent chunks
        activeIds?.add(requestId);

        // Send ACK to server via the latest agent (the socket may
        // have been replaced since reconnectToStream was called).
        this.agent.send(
          JSON.stringify({
            type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
            id: requestId
          })
        );

        // Return a ReadableStream fed by the replayed + live chunks
        done(this._createResumeStream(requestId));
      };

      // Send the resume request. PartySocket queues sends when
      // the socket isn't open yet and flushes on connect, so
      // this works regardless of current readyState.
      try {
        this.agent.send(
          JSON.stringify({
            type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST
          })
        );
      } catch {
        // WebSocket may already be closed
      }

      // Timeout: if no CF_AGENT_STREAM_RESUMING arrives (no active
      // stream, or WebSocket never connects), resolve null.
      timeout = setTimeout(() => done(null), 5000);
    });
  }

  /**
   * Creates a ReadableStream that receives resumed stream chunks
   * and forwards them to useChat as UIMessageChunk objects.
   */
  private _createResumeStream(
    requestId: string
  ): ReadableStream<UIMessageChunk> {
    // Read agent at resolve time (not when reconnectToStream was called)
    // so chunk listener attaches to the latest socket after _pk changes.
    const agent = this.agent;
    const activeIds = this.activeRequestIds;
    const chunkController = new AbortController();
    let completed = false;

    const finish = (action: () => void) => {
      if (completed) return;
      completed = true;
      try {
        action();
      } catch {
        // Stream may already be closed
      }
      activeIds?.delete(requestId);
      chunkController.abort();
    };

    return new ReadableStream<UIMessageChunk>({
      start(controller) {
        const onMessage = (event: MessageEvent) => {
          try {
            const data = JSON.parse(
              event.data as string
            ) as OutgoingMessage<UIMessage>;

            if (data.type !== MessageType.CF_AGENT_USE_CHAT_RESPONSE) return;
            if (data.id !== requestId) return;

            if (data.error) {
              finish(() =>
                controller.error(new Error(data.body || "Stream error"))
              );
              return;
            }

            // Parse and enqueue the chunk
            if (data.body?.trim()) {
              try {
                const chunk = JSON.parse(data.body) as UIMessageChunk;
                controller.enqueue(chunk);
              } catch {
                // Skip malformed chunk bodies
              }
            }

            if (data.done) {
              finish(() => controller.close());
            }
          } catch {
            // Ignore non-JSON messages
          }
        };

        agent.addEventListener("message", onMessage, {
          signal: chunkController.signal
        });
      },
      cancel() {
        finish(() => {});
      }
    });
  }
}
