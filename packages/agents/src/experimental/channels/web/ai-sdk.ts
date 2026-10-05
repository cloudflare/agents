import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import {
  toTranscriptMessage,
  toUIMessageChunk
} from "../../../harness/ai-sdk/turns";
import type { Json, ToolPart, TurnStatus } from "../protocol";
import type { ClientEvent, WebChannelClient } from "./client";

export type WebChannelChatTransportOptions = {
  /**
   * Client tools the transport runs itself when the agent gives this
   * participant a call. Without them, answer calls with `addToolOutput`.
   */
  tools?: Record<string, (input: Json) => Json | Promise<Json>>;
};

/**
 * What the transport reads from `sendMessages`. Kept structural so the
 * transport also fits the `ChatTransport` of a newer `ai` release, such as
 * the one `@ai-sdk/tui` brings.
 */
export type WebChannelSendOptions = {
  trigger: "submit-message" | "regenerate-message";
  messages: readonly {
    id: string;
    role: UIMessage["role"];
    parts: readonly object[];
  }[];
  abortSignal?: AbortSignal;
};

type Follow = {
  /** The turn to follow; for a new message, the turn the message starts. */
  turnId?: string;
  startedBy?: string;
  responseId?: string;
  events: ClientEvent[];
  signal?: AbortSignal;
};

/**
 * An AI SDK `ChatTransport` over a Web Channel connection, for `useChat`
 * and `@ai-sdk/tui`. Each call streams one turn until it settles, or until
 * it waits for input the transport cannot give.
 *
 * The agent owns the transcript, so only the newest user message or the
 * newest answers to pending tool calls are sent; the rest of `messages` is
 * ignored. Regenerating a message is not supported.
 */
export class WebChannelChatTransport implements ChatTransport<UIMessage> {
  readonly #client: WebChannelClient;
  readonly #tools: WebChannelChatTransportOptions["tools"];

  constructor(
    client: WebChannelClient,
    options: WebChannelChatTransportOptions = {}
  ) {
    this.#client = client;
    this.#tools = options.tools;
  }

  async sendMessages({
    trigger,
    messages,
    abortSignal
  }: WebChannelSendOptions): Promise<ReadableStream<UIMessageChunk>> {
    if (trigger === "regenerate-message") {
      throw new Error(
        "Channels cannot regenerate a message. Send a new message instead."
      );
    }
    await this.#connected();
    // SAFETY: every AI SDK 7 release shares these UI message shapes.
    const last = messages.at(-1) as UIMessage | undefined;
    if (last?.role === "user") {
      const id = crypto.randomUUID();
      const message = {
        ...toTranscriptMessage(last),
        id,
        role: "user" as const
      };
      return this.#follow({
        startedBy: id,
        events: [
          {
            type: "message",
            eventId: id,
            message,
            ...this.#clientTools()
          }
        ],
        signal: abortSignal
      });
    }
    const answers = last ? this.#answers(last) : [];
    if (answers.length === 0) {
      throw new Error(
        "Nothing to send: the last message is neither a user message nor an answer to a pending tool call."
      );
    }
    return this.#follow({
      turnId: answers[0].turnId,
      events: answers,
      signal: abortSignal
    });
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    await this.#connected();
    const running = this.#client.state.turns.find(
      (turn) => turn.status === "running"
    );
    if (running?.status !== "running") return null;
    return this.#follow({
      turnId: running.turnId,
      responseId: running.responseId,
      events: []
    });
  }

  #connected(): Promise<void> {
    if (this.#client.state.connected) return Promise.resolve();
    return new Promise((resolve) => {
      const off = this.#client.subscribe((state) => {
        if (!state.connected) return;
        off();
        resolve();
      });
    });
  }

  #clientTools() {
    return this.#tools
      ? { clientTools: Object.keys(this.#tools).map((name) => ({ name })) }
      : {};
  }

  /** Answers in the message to tool calls the agent is waiting on. */
  #answers(message: UIMessage) {
    const answers: (ClientEvent & { turnId: string })[] = [];
    for (const part of toTranscriptMessage(message).parts) {
      if (part.type !== "tool") continue;
      const pending = this.#pending(part.toolCallId);
      if (!pending) continue;
      const { turnId, call } = pending;
      if (
        call.state === "approval-requested" &&
        call.approval &&
        part.state === "approval-responded" &&
        part.approval?.approved !== undefined
      ) {
        answers.push({
          type: "approval-response",
          turnId,
          approvalId: call.approval.id,
          approved: part.approval.approved,
          ...(part.approval.reason !== undefined && {
            reason: part.approval.reason
          })
        });
      } else if (
        call.state === "input-available" &&
        (part.state === "output-available" || part.state === "output-error")
      ) {
        answers.push({
          type: "tool-result",
          turnId,
          toolCallId: part.toolCallId,
          result:
            part.state === "output-available"
              ? { ok: true, output: part.output ?? null }
              : { ok: false, errorText: part.errorText },
          ...this.#clientTools()
        });
      }
    }
    return answers;
  }

  /** A tool call waiting for input, and the turn waiting on it. */
  #pending(toolCallId: string): { turnId: string; call: ToolPart } | undefined {
    const { messages, turns } = this.#client.state;
    for (const message of messages) {
      const call = message.parts.find(
        (part): part is ToolPart =>
          part.type === "tool" && part.toolCallId === toolCallId
      );
      if (!call) continue;
      const turn = turns.find(
        (t) =>
          t.status === "settled" &&
          t.outcome === "awaiting-input" &&
          t.messageIds.includes(message.id)
      );
      return turn && { turnId: turn.turnId, call };
    }
    return undefined;
  }

  /** Calls in a settled turn that this transport can run for its participant. */
  #runnable(turn: TurnStatus): ToolPart[] {
    const { messages, you } = this.#client.state;
    if (turn.status !== "settled" || !this.#tools || !you) return [];
    return messages
      .filter((message) => turn.messageIds.includes(message.id))
      .flatMap((message) => message.parts)
      .filter(
        (part): part is ToolPart =>
          part.type === "tool" &&
          part.state === "input-available" &&
          part.owner === you.id &&
          Object.hasOwn(this.#tools ?? {}, part.toolName)
      );
  }

  #follow(follow: Follow): ReadableStream<UIMessageChunk> {
    const client = this.#client;
    let { turnId, responseId } = follow;
    let responseEnded = responseId === undefined;
    let settled: TurnStatus | undefined;
    let answering = false;
    let offline = false;
    let done = false;
    const cleanup: (() => void)[] = [];

    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        const enqueue = (chunk: UIMessageChunk) => {
          if (!done) controller.enqueue(chunk);
        };
        const finish = (...last: UIMessageChunk[]) => {
          if (done) return;
          for (const chunk of last) controller.enqueue(chunk);
          done = true;
          for (const off of cleanup) off();
          controller.close();
        };
        const fail = (error: unknown) =>
          finish({
            type: "error",
            errorText: error instanceof Error ? error.message : String(error)
          });

        const send = (event: ClientEvent) =>
          client.send(event).catch((error: unknown) => fail(error));

        const answer = async (calls: ToolPart[]) => {
          answering = true;
          settled = undefined;
          for (const call of calls) {
            const run = this.#tools?.[call.toolName];
            let result:
              | { ok: true; output: Json }
              | { ok: false; errorText: string };
            try {
              result = {
                ok: true,
                output: (await run?.(call.input ?? null)) ?? null
              };
              enqueue({
                type: "tool-output-available",
                toolCallId: call.toolCallId,
                output: result.output
              });
            } catch (error) {
              result = { ok: false, errorText: String(error) };
              enqueue({
                type: "tool-output-error",
                toolCallId: call.toolCallId,
                errorText: result.errorText
              });
            }
            if (!turnId) return;
            await send({
              type: "tool-result",
              turnId,
              toolCallId: call.toolCallId,
              result,
              ...this.#clientTools()
            });
          }
          answering = false;
          // The continuation may have settled while the answers were sent.
          settle();
        };

        const settle = () => {
          if (!settled || settled.status !== "settled") return;
          if (!responseEnded || answering) return;
          switch (settled.outcome) {
            case "awaiting-input": {
              const calls = this.#runnable(settled);
              if (calls.length > 0) {
                void answer(calls);
                return;
              }
              return finish({ type: "finish" });
            }
            case "completed":
              return finish({ type: "finish" });
            case "aborted":
              return finish({ type: "abort" });
            case "failed":
              return finish({
                type: "error",
                errorText: settled.error ?? "The turn failed."
              });
          }
        };

        // A new turn builds a new message; the AI SDK keys messages by id,
        // so without one each reply would replace the last. A continuation
        // keeps the id the caller already has.
        enqueue(
          follow.startedBy
            ? { type: "start", messageId: crypto.randomUUID() }
            : { type: "start" }
        );
        if (responseId) {
          for (const chunk of client.chunksOf(responseId) ?? []) {
            enqueue(toUIMessageChunk(chunk));
          }
        }

        cleanup.push(
          client.onActivity((activity) => {
            if (activity.type === "turn") {
              const turn = activity.turn;
              if (!turnId && turn.startedBy === follow.startedBy) {
                turnId = turn.turnId;
              }
              if (turn.turnId !== turnId) return;
              if (turn.status === "running" && turn.responseId !== responseId) {
                responseId = turn.responseId;
                responseEnded = false;
              }
              settled = turn.status === "settled" ? turn : undefined;
              return settle();
            }
            if (activity.responseId !== responseId) return;
            if (activity.type === "chunks") {
              for (const chunk of activity.chunks) {
                enqueue(toUIMessageChunk(chunk));
              }
            } else {
              responseEnded = true;
              settle();
            }
          }),
          client.subscribe((state) => {
            if (!state.connected) {
              offline = true;
              return;
            }
            if (!offline) return;
            offline = false;
            // The turn settled while this client was away.
            if (turnId && !state.turns.some((t) => t.turnId === turnId)) {
              finish({ type: "finish" });
            }
          })
        );

        const abort = () => {
          if (turnId)
            void client.send({ type: "cancel", turnId }).catch(() => {});
          finish();
        };
        if (follow.signal?.aborted) return abort();
        follow.signal?.addEventListener("abort", abort, { once: true });
        cleanup.push(() => follow.signal?.removeEventListener("abort", abort));

        for (const event of follow.events) void send(event);
      },
      cancel: () => {
        done = true;
        for (const off of cleanup) off();
      }
    });
  }
}
