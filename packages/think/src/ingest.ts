import type { SessionMessage } from "agents/experimental/memory/session";
import type { UIMessage } from "ai";
import type { StreamCallback } from "./think";

/**
 * The host-facing wire contract for {@link Think.ingest}: the input shape and
 * the NDJSON event frames carried on the returned byte stream, plus decode
 * helpers for hosts. Kept out of `think.ts` so the contract is reviewable in
 * isolation — nothing in this module knows how turns run.
 */

type IngestContent =
  | { text: string; message?: never }
  | { message: UIMessage; text?: never };

export type IngestInput = IngestContent & {
  channelId: string;
  idempotencyKey?: string;
};

export type IngestStreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; message: SessionMessage }
  | { type: "error"; message: string };

export type IngestReply = {
  text: string;
  message?: SessionMessage;
};

/** Decode an ingest byte stream into its NDJSON events. */
export async function* decodeIngestStream(
  stream: ReadableStream<Uint8Array>
): AsyncIterable<IngestStreamEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length > 0) yield JSON.parse(line) as IngestStreamEvent;
      }
    }

    buffer += decoder.decode();
    if (buffer.length > 0) yield JSON.parse(buffer) as IngestStreamEvent;
  } finally {
    reader.releaseLock();
  }
}

/** Wait-semantics-by-buffering: drain the stream and return the final reply. */
export async function collectIngestReply(
  stream: ReadableStream<Uint8Array>
): Promise<IngestReply> {
  let text = "";
  let message: SessionMessage | undefined;

  for await (const event of decodeIngestStream(stream)) {
    if (event.type === "delta") {
      text += event.text;
    } else if (event.type === "done") {
      message = event.message;
    } else {
      throw new Error(event.message);
    }
  }

  return { text, message };
}

/** Extract the plain text of a UIMessage's text parts (ingest input helper). */
export function textFromUIMessage(message: UIMessage | undefined): string {
  return (message?.parts ?? [])
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text"
    )
    .map((part) => part.text)
    .join("");
}

/**
 * Build the byte stream returned by {@link Think.ingest} and kick off the
 * turn that feeds it.
 *
 * Lifecycle contract: the stream is an observation tap. `run` is started
 * eagerly and the turn behind it must complete and persist even if the
 * consumer never reads, reads slowly, or cancels.
 *
 * Backpressure is deliberately not propagated to the model turn: frames are
 * enqueued without awaiting consumer readiness. This matches the existing web
 * WebSocket surface (slow clients buffer server-side; they never stall the
 * turn), and the buffer is bounded by a single turn's output. A cancelled
 * stream stops buffering immediately (enqueue throws, and we stop writing).
 */
export function createIngestStream(
  run: (callback: StreamCallback) => Promise<unknown>,
  finalAssistantMessage: () => SessionMessage | undefined
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let closed = false;

  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      const write = (event: IngestStreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {}
      };
      let terminal = false;
      const writeTerminal = (event: IngestStreamEvent) => {
        if (terminal) return;
        terminal = true;
        write(event);
        close();
      };

      const callback: StreamCallback = {
        onStart: () => {},
        onEvent: (json) => {
          let chunk: unknown;
          try {
            chunk = JSON.parse(json);
          } catch {
            return;
          }
          if (
            chunk != null &&
            typeof chunk === "object" &&
            (chunk as { type?: unknown }).type === "text-delta" &&
            typeof (chunk as { delta?: unknown }).delta === "string"
          ) {
            write({ type: "delta", text: (chunk as { delta: string }).delta });
          }
        },
        onDone: () => {
          const message = finalAssistantMessage();
          if (!message) {
            writeTerminal({
              type: "error",
              message: "ingest: turn completed without an assistant message"
            });
            return;
          }
          writeTerminal({ type: "done", message });
        },
        onError: (message) => {
          writeTerminal({ type: "error", message });
        },
        onInterrupted: () => {
          writeTerminal({
            type: "error",
            message: "ingest: turn was interrupted before completion"
          });
        }
      };

      void (async () => {
        try {
          await run(callback);
        } catch (error) {
          writeTerminal({
            type: "error",
            message: error instanceof Error ? error.message : String(error)
          });
        } finally {
          // A turn that resolves without a terminal frame (e.g. submit-style
          // completion paths) still closes the stream for the consumer.
          writeTerminal({
            type: "error",
            message: "ingest: turn ended without a completion signal"
          });
        }
      })();
    },
    cancel: () => {
      // Consumer walked away. Stop buffering; never abort the turn.
      closed = true;
    }
  });
}
