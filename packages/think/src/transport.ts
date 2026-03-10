/**
 * AgentChatTransport — bridges the AI SDK's useChat hook with an Agent
 * WebSocket connection that speaks Think's streaming protocol.
 *
 * Features:
 *   - Request ID correlation: each request gets a unique ID, only matching
 *     WS messages are processed
 *   - Cancel: sends { type: "cancel", requestId } to stop server-side streaming
 *   - Completion guard: close/error/abort are idempotent
 *   - Signal-based cleanup: uses AbortController signal on addEventListener
 *   - Stream resumption: reconnectToStream sends resume-request, server replays
 *     buffered chunks via ChunkRelay
 *
 * @example
 * ```tsx
 * import { AgentChatTransport } from "@cloudflare/think/transport";
 * import { useAgent } from "agents/react";
 * import { useChat } from "@ai-sdk/react";
 *
 * const agent = useAgent({ agent: "MyAssistant" });
 * const transport = useMemo(() => new AgentChatTransport(agent), [agent]);
 * const { messages, sendMessage, status } = useChat({ transport });
 * ```
 */

import type { UIMessage, UIMessageChunk, ChatTransport } from "ai";

/**
 * Minimal interface for the agent connection object.
 * Satisfied by the return value of `useAgent()` from `agents/react`.
 */
export interface AgentSocket {
  addEventListener(
    type: "message",
    handler: (event: MessageEvent) => void,
    options?: { signal?: AbortSignal }
  ): void;
  removeEventListener(
    type: "message",
    handler: (event: MessageEvent) => void
  ): void;
  call(method: string, args?: unknown[]): Promise<unknown>;
  send(data: string): void;
}

/**
 * Options for constructing an AgentChatTransport.
 */
export interface AgentChatTransportOptions {
  /**
   * The server-side RPC method to call when sending a message.
   * Receives `[text, requestId]` as arguments.
   * @default "sendMessage"
   */
  sendMethod?: string;

  /**
   * Timeout in milliseconds for reconnectToStream to wait for a
   * stream-resuming response before giving up.
   * @default 500
   */
  resumeTimeout?: number;
}

/**
 * Extract the text content from a UIMessage's parts.
 */
function getMessageText(msg: UIMessage): string {
  return msg.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/**
 * ChatTransport implementation for Agent WebSocket connections.
 *
 * Speaks the wire protocol used by Think's `chat()` method
 * and ChunkRelay on the server:
 *   - `stream-start`   → new stream with requestId
 *   - `stream-event`   → UIMessageChunk payload
 *   - `stream-done`    → stream complete
 *   - `stream-resuming` → replay after reconnect
 *   - `cancel`         → client→server abort
 */
export class AgentChatTransport implements ChatTransport<UIMessage> {
  #agent: AgentSocket;
  #activeRequestIds = new Set<string>();
  #currentFinish: (() => void) | null = null;
  #sendMethod: string;
  #resumeTimeout: number;

  constructor(agent: AgentSocket, options?: AgentChatTransportOptions) {
    this.#agent = agent;
    this.#sendMethod = options?.sendMethod ?? "sendMessage";
    this.#resumeTimeout = options?.resumeTimeout ?? 500;
  }

  /**
   * Detach from the current stream. Call this before switching agents
   * or cleaning up to ensure the stream controller is closed.
   */
  detach() {
    this.#currentFinish?.();
    this.#currentFinish = null;
  }

  async sendMessages({
    messages,
    abortSignal
  }: Parameters<ChatTransport<UIMessage>["sendMessages"]>[0]): Promise<
    ReadableStream<UIMessageChunk>
  > {
    const lastMessage = messages[messages.length - 1];
    const text = getMessageText(lastMessage);
    const requestId = crypto.randomUUID().slice(0, 8);

    let completed = false;
    const abortController = new AbortController();
    let streamController!: ReadableStreamDefaultController<UIMessageChunk>;

    const finish = (action: () => void) => {
      if (completed) return;
      completed = true;
      this.#currentFinish = null;
      try {
        action();
      } catch {
        /* stream may already be closed */
      }
      this.#activeRequestIds.delete(requestId);
      abortController.abort();
    };

    this.#currentFinish = () => finish(() => streamController.close());

    const onAbort = () => {
      if (completed) return;
      try {
        this.#agent.send(JSON.stringify({ type: "cancel", requestId }));
      } catch {
        /* ignore send failures */
      }
      finish(() =>
        streamController.error(
          Object.assign(new Error("Aborted"), { name: "AbortError" })
        )
      );
    };

    const stream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        streamController = controller;
      },
      cancel() {
        onAbort();
      }
    });

    this.#agent.addEventListener(
      "message",
      (event: MessageEvent) => {
        if (typeof event.data !== "string") return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.requestId !== requestId) return;
          if (msg.type === "stream-event") {
            const chunk: UIMessageChunk = JSON.parse(msg.event);
            streamController.enqueue(chunk);
          } else if (msg.type === "stream-done") {
            finish(() => streamController.close());
          }
        } catch {
          /* ignore parse errors */
        }
      },
      { signal: abortController.signal }
    );

    if (abortSignal) {
      abortSignal.addEventListener("abort", onAbort, { once: true });
      if (abortSignal.aborted) onAbort();
    }

    this.#activeRequestIds.add(requestId);

    this.#agent
      .call(this.#sendMethod, [text, requestId])
      .catch((error: Error) => {
        finish(() => streamController.error(error));
      });

    return stream;
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    const resumeTimeout = this.#resumeTimeout;

    return new Promise<ReadableStream<UIMessageChunk> | null>((resolve) => {
      let resolved = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const done = (value: ReadableStream<UIMessageChunk> | null) => {
        if (resolved) return;
        resolved = true;
        if (timeout) clearTimeout(timeout);
        this.#agent.removeEventListener("message", handler);
        resolve(value);
      };

      const handler = (event: MessageEvent) => {
        if (typeof event.data !== "string") return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "stream-resuming") {
            done(this.#createResumeStream(msg.requestId));
          }
        } catch {
          /* ignore */
        }
      };

      this.#agent.addEventListener("message", handler);

      try {
        this.#agent.send(JSON.stringify({ type: "resume-request" }));
      } catch {
        /* WebSocket may not be open yet */
      }

      timeout = setTimeout(() => done(null), resumeTimeout);
    });
  }

  #createResumeStream(requestId: string): ReadableStream<UIMessageChunk> {
    const abortController = new AbortController();
    let completed = false;

    const finish = (action: () => void) => {
      if (completed) return;
      completed = true;
      try {
        action();
      } catch {
        /* stream may already be closed */
      }
      this.#activeRequestIds.delete(requestId);
      abortController.abort();
    };

    this.#activeRequestIds.add(requestId);

    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        this.#agent.addEventListener(
          "message",
          (event: MessageEvent) => {
            if (typeof event.data !== "string") return;
            try {
              const msg = JSON.parse(event.data);
              if (msg.requestId !== requestId) return;
              if (msg.type === "stream-event") {
                const chunk: UIMessageChunk = JSON.parse(msg.event);
                controller.enqueue(chunk);
              } else if (msg.type === "stream-done") {
                finish(() => controller.close());
              }
            } catch {
              /* ignore */
            }
          },
          { signal: abortController.signal }
        );
      },
      cancel() {
        finish(() => {});
      }
    });
  }
}
