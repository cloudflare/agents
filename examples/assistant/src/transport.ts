/**
 * AgentChatTransport — bridges the AI SDK's useChat hook with an Agent
 * WebSocket connection that speaks a custom streaming protocol.
 *
 * This transport is specific to the orchestrator relay pattern used in
 * this example — it speaks stream-event/stream-done, not the standard
 * CF_AGENT protocol. For direct Think connections, use useAgentChat
 * from @cloudflare/ai-chat instead.
 */

import type { UIMessage, UIMessageChunk, ChatTransport } from "ai";

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

function getMessageText(msg: UIMessage): string {
  return msg.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

export class AgentChatTransport implements ChatTransport<UIMessage> {
  #agent: AgentSocket;
  #activeRequestIds = new Set<string>();
  #currentFinish: (() => void) | null = null;

  constructor(agent: AgentSocket) {
    this.#agent = agent;
  }

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

    this.#agent.call("sendMessage", [text, requestId]).catch((error: Error) => {
      finish(() => streamController.error(error));
    });

    return stream;
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
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

      timeout = setTimeout(() => done(null), 500);
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
